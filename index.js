const mqtt = require('mqtt');
const _ = require('underscore');

module.exports = function (app) {
  var plugin = {};

  plugin.id = 'signalk-mqtt-bridge';
  plugin.name = 'Bridge between SignalK and MQTT';
  plugin.description = 'SignalK Node server plugin that acts as a bridge between SignalK data and MQTT';

  // Infer system id
  // If mmsi is set, this will match the mmsi
  // If mmsi is not set, this will be the last segment of the generated uuid
  plugin.systemId = app.selfId.split(':').pop().split('-').pop();

  plugin.schema = {
    title: 'SignalK <> MQTT Bridge',
    type: 'object',
    required: ['mqttBrokerAddress'],
    description: `SignalK will use system id ${plugin.systemId} to interact with MQTT`,
    properties: {
      mqttBrokerAddress: {
        type: "string",
        title: "MQTT broker address to connect to. Format: mqtt://user:pass@ip_or_host:1883"
      },
      rejectUnauthorized: {
        type: 'boolean',
        title: 'Reject self signed and invalid server certificates',
        default: true
      },
      keepaliveTtl: {
        type: 'number',
        title: 'TTL of the MQTT keepalive in seconds',
        default: 60
      }
    }
  };

  // Functions to call when the plugin stops
  plugin.onStop = [];

  // Delta subscriptions from MQTT
  plugin.subscriptions = [];

  plugin.start = function (options, restartPlugin) {
    app.debug('Plugin starting');

    plugin.keepaliveTtl = parseInt(options.keepaliveTtl) || plugin.schema.properties.keepaliveTtl.default;

    // Initialize delta subscriptions
    plugin.subscriptions = [];

    // Connect to mqtt broker
    plugin.client = mqtt.connect(options.mqttBrokerAddress, {
      rejectUnauthorized: Boolean(options.rejectUnauthorized),
      reconnectPeriod: 5000,
      clientId: 'signalk/' + plugin.systemId,
    });

    // Handle graceful stop
    plugin.onStop.push(_ => plugin.client.end());

    // Handle errors
    plugin.client.on('error', (err) => {
      app.error(`Error connecting to MQTT broker: ${err}`);
      app.setPluginError(`Error connecting to MQTT broker: ${err}`);
    });

    // Start bridge when MQTT client is connected
    plugin.client.on('connect', () => {
      app.debug('MQTT connected');
      app.setPluginStatus('MQTT Connected');
      startBridge();
    });

    plugin.client.on('close', () => {
      app.debug('MQTT connection closed');
      app.setPluginError('MQTT connection closed');
    });

    // Handle incoming MQTT messages
    plugin.client.on('message', onMessage);

    // Remove stale subscriptions each second
    if (plugin.expireSubscriptionsInterval === undefined) {
      plugin.expireSubscriptionsInterval = setInterval(expireSubscriptions, 1000);
      plugin.onStop.push(() => {
        clearInterval(plugin.expireSubscriptionsInterval);
        plugin.expireSubscriptionsInterval = undefined;
      });
    }

    // Setup SignalK delta subscription
    plugin.onStop.push(app.streambundle
      .getBus()
      .debounceImmediate(500)
      .onValue(handleDelta));
  };

  // Handle plugin stop
  plugin.stop = function () {
    plugin.onStop.forEach(f => f());
    plugin.onStop = [];

    app.debug('Plugin stopped');
  };

  // Handle MQTT client connections or reconnections
  function startBridge() {
    plugin.client.subscribe('R/signalk/' + plugin.systemId + '/#');
    plugin.client.subscribe('W/signalk/' + plugin.systemId + '/#');
    plugin.client.subscribe('P/signalk/' + plugin.systemId + '/#');

    // Indicate that the keepalive mechanism is supported
    publishMqtt('N/signalk/' + plugin.systemId + '/keepalive', '1', {
      retain: true
    });

    // Publish serial number
    publishMqtt('N/signalk/' + plugin.systemId + '/system/Serial', plugin.systemId, {
      retain: true
    });
  }

  // Handle incomming MQTT messages
  function onMessage(topic, messageBuffer) {
    var message = messageBuffer.toString().trim();

    app.debug('Received message to topic ' + topic + ': ' + message);

    var topicParts = topic.split('/');
    var action = topicParts[0];
    var signalk = topicParts[1];
    var systemId = topicParts[2];
    var subTopic = topicParts.slice(3).join('/');

    if (signalk != 'signalk' || systemId != plugin.systemId) {
      app.debug('Unknown system id ' + systemId + '. Ignoring');
      return;
    }

    switch (action) {
      case 'R':
        if (subTopic == 'keepalive') {
          handleKeepalive(message);
        } else {
          handleRead(subTopic);
        }
        break;
      case 'W':
        handleWrite(subTopic, message);
        break;
      case 'P':
        handlePut(subTopic, message);
        break;
      default:
        app.debug('Unknown action ' + action + '. Ignoring');
        break;
    }
  }

  // Handles the keepalive read message. Will subscribe to any topics
  // passed in the message payload, or to all if payload is empty
  function handleKeepalive(message) {
    if (message.length == 0) {
      subscribeToTopic('#');
    } else {
      JSON.parse(message).forEach(topic => {
        subscribeToTopic(topic);
      });
    }
  }

  // Handles an incoming delta from SignalK
  function handleDelta(delta) {
    if (
      !('context' in delta) || typeof delta.context !== 'string' ||
      !('path' in delta) || typeof delta.path !== 'string' ||
      !('value' in delta)
    ) {
      app.debug('Malformed delta. Ignoring. ' + JSON.stringify(delta));
      return;
    }

    var subTopic;
    if (delta.context == 'vessels.' + app.selfId) {
      subTopic = 'vessels/self/' + signalkPathToMqttTopic(delta.path);
    } else {
      subTopic = signalkPathToMqttTopic([delta.context, delta.path].join('.'));
    }

    if (!topicIsSubscribed(subTopic)) {
      // No subscriptions for this topic. Ignoring
      return;
    }

    app.debug('Got delta for topic ' + subTopic);

    // Publish message
    publishMqtt('N/signalk/' + plugin.systemId + '/' + subTopic, signalkDeltaToMqttMessage(delta));
  }

  // Handles writes from MQTT into SignalK
  function handleWrite(topic, message) {
    var topicParts = topic.split('/');

    if (topicParts.length < 3) {
      app.debug('Delta path should begin with a two parts context. Got: ' + topicParts.join('.'));
      return;
    }

    if (topicParts[1] == 'self') {
      topicParts[1] = app.selfId;
    }

    var context = [topicParts[0], topicParts[1]].join('.');
    var path = topicParts.slice(2).join('.');
    var value = Number(message);
    if (isNaN(message)) {
      value = message;
    }

    app.handleMessage(plugin.id, {
      context: context,
      updates: [
        {
          $source: 'mqtt',
          values: [
            {
              path: path,
              value: value
            }
          ]
        }
      ]
    });
  }

  // Handles PUTs from MQTT into SignalK
  function handlePut(topic, message) {
    var putCb = function (resp) {
      if (resp.statusCode > 299) app.debug('Error in PUT request (' + resp.statusCode + ' - ' + resp.state + '): ' + resp.message);
    };

    var topicParts = topic.split('/');
    if (topicParts[1] == "self") {
      app.putSelfPath(topicParts.slice(2).join('.'), message, putCb);
    } else {
      app.putPath(topicParts.join('.'), message, putCb);
    }
  }

  // Handles reads from SignalK into MQTT
  function handleRead(topic) {
    var path = mqttTopicToSignalkPath(topic);
    app.debug('Read SignalK path ' + path);

    var data;
    if (path.startsWith('vessels.self')) {
      data = app.getSelfPath(path.substring(13))
    } else {
      data = app.getPath(path);
    }

    publishMqtt('N/signalk/' + plugin.systemId + '/' + topic, signalkDataToMqttMessage(data));
  }

  // Add MQTT subscription to deltas
  function subscribeToTopic(topic) {
    // First check if topic is already subscribed
    for (var i = 0; i < plugin.subscriptions.length; i++) {
      if (plugin.subscriptions[i].topic == topic) {
        // If topic already subscribed, renew
        app.debug('Renewing subscription to topic ' + plugin.subscriptions[i].topic);
        plugin.subscriptions[i].expires = getNow() + plugin.keepaliveTtl;
        return;
      }
    }

    // Topic wasn't subscribed yet
    app.debug('New subscription to topic ' + topic);
    plugin.subscriptions.push({
      topic: topic,
      expires: getNow() + plugin.keepaliveTtl
    });
  }

  // Expire subscriptions
  function expireSubscriptions() {
    // Iterate from the back of the array so i keeps being valid
    for (var i = plugin.subscriptions.length - 1; i > -1; i--) {
      if (plugin.subscriptions[i].expires < getNow()) {
        app.debug('Expiring subscription to topic ' + plugin.subscriptions[i].topic);
        plugin.subscriptions.splice(i, 1);
      }
    }
  }

  // Checks if there's an active subscription for the incoming delta
  function topicIsSubscribed(topic) {
    return _.find(plugin.subscriptions, subs => {
      return matchTopic(subs.topic, topic);
    }) != undefined;
  }

  // Checks for a match between a topic and a topic subscription
  // e.g. 'vessels/self/#' and 'vessels/self/navigation/position'
  function matchTopic(topic1, topic2) {
    var t1 = topic1.split('/');
    var t2 = topic2.split('/');
    for (var i = 0; i < Math.max(t1.length, t2.length); i++) {
      if (i >= t1.length || i >= t2.length) {
        return false;
      }
      if ([t1[i], t2[i]].includes('+')) {
        continue;
      }
      if ([t1[i], t2[i]].includes('#')) {
        return true
      }
      if (t1[i] == t2[i]) {
        continue;
      }

      return false;
    }

    return true;
  }

  // Translates a Signalk Path into an MQTT topic
  function signalkPathToMqttTopic(path) {
    return path.replaceAll('.', '/');
  }

  // Translates an MQTT topic into a Signalk Path
  function mqttTopicToSignalkPath(topic) {
    return topic.replaceAll('/', '.');
  }

  // Transforms a SingalK data object as an MQTT message
  function signalkDataToMqttMessage(signalkData) {
    if (signalkData === undefined) {
      return null;
    }

    return JSON.stringify(signalkData);
  }

  // Sanitizes a SignalK delta to get rid of redundant data and converts it to a string
  function signalkDeltaToMqttMessage(delta) {
    return JSON.stringify(_.pick(delta, 'value', '$source', 'timestamp', 'isMeta'));
  }

  // Gets the current timestamp in seconds
  function getNow() {
    return Math.floor(Date.now() / 1000);
  }

  // Publish MQTT message only if broker is connected, drop it otherwise
  function publishMqtt(topic, message, options = {}) {
    if (plugin.client.connected) {
      plugin.client.publish(topic, message, options);
    }
  }

  return plugin;
};
