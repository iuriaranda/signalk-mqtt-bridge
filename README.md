# SignalK <> MQTT bridge

SignalK Node server plugin that acts as a bridge between SignalK data and MQTT. Its purpose is similar to the one of the [`signalk-mqtt-gw`](https://github.com/tkurki/signalk-mqtt-gw) plugin, but this one has a different interaction with MQTT, inspired by [Victron's dbus-mqtt module](https://github.com/victronenergy/dbus-mqtt).

Note that this plugin doesn't have an embedded MQTT broker. It connects as a client to an MQTT broker running in the system or remotely.

## Features

<!-- no toc -->
- [Scoped MQTT topics](#scoped-mqtt-topics)
- [Keepalive mechanism](#keepalive) to avoid unnecessary load on the MQTT broker
- [Send SignalK deltas to MQTT](#subscribe-to-signalk-deltas)
- [Request specific SignalK paths from MQTT](#request-signalk-data-from-mqtt)
- [Push deltas to SignalK from MQTT](#send-deltas-to-signalk-via-mqtt)
- [Send PUT requests to SignalK from MQTT](#send-put-requests-to-signalk-via-mqtt)

## Scoped MQTT topics

All MQTT topics used by this plugin are prefixed with `<action>/signalk/<systemId>/`

- `<systemId>` is the last section of the SignalK server uuid, e.g. `4881db477e55` from `urn:mrn:signalk:uuid:2bb1928e-3118-415e-b242-4881db477e55`. This is to avoid conflicts when more than one SignalK server is connected to the same MQTT broker
- `<action>` defines the purpose of the topic, defined in the sections below
  - `N`: data sent from SignalK
  - `R`: read requests sent from MQTT clients to SignalK
  - `D`: deltas sent from MQTT clients to SignalK
  - `P`: PUT requests sent from MQTT clients to SignalK

When it connects to an MQTT broker, the plugin will publish two messages:

- to topic `N/signalk/<systemId>/keepalive` with payload `1` to indicate that the keepalive mechanism is supported
- to topic `N/signalk/<systemId>/system/Serial` with the `<systemId>` as payload

## Keepalive

With the keepalive, MQTT clients can trigger the plugin to send all SignalK deltas or subscribe to deltas for specific paths.

To activate the keepalive, publish a message to topic `R/signalk/<systemId>/keepalive`. The payload may be blank, or may contain a JSON-encoded list of topics of interest. The keepalive will last for the configured TTL in the plugin config, 60 seconds by default. After that, the plugin will stop sending deltas until a new message is published to `R/signalk/<systemId>/keepalive`.

The topics of interest in the keepalive message follow the same notation as MQTT topic subscriptions. Any part of the topic-matching string can be replaced with a `+` to indicate a wildcard. The string may end with a `#` which indicates that all trailing parts are accepted.

For example, the following will instruct the plugin to send deltas for paths `vessels.self.electrical.batteries.*.current` and `vessels.*.navigation.position`.

```bash
mosquitto_pub -m '["vessels/self/electrical/batteries/+/current", "vessels/+/navigation/position"]' -t 'R/signalk/4881db477e55/keepalive'
```

An empty payload will instruct the plugin to send messages for all deltas.

```bash
mosquitto_pub -m '' -t 'R/signalk/4881db477e55/keepalive'
```

To keep the keepalive active all the time, you could use a command like this:

```bash
while :; do mosquitto_pub -m '' -t 'R/signalk/4881db477e55/keepalive'; sleep 30; done
```

## Subscribe to SignalK deltas

This SignalK plugin sends deltas to MQTT using the `N/` topic prefix. To receive deltas from SignalK, first subscribe to the topics of interest, then send periodic keepalive messages to keep the plugin active.

For example, use this to subscribe to deltas for all paths under `vessels.self.*`

```bash
mosquitto_sub -t 'N/signalk/4881db477e55/vessels/self/#'

# in a separate terminal
while :; do mosquitto_pub -m '["vessels/self/#"]' -t 'R/signalk/4881db477e55/keepalive'; sleep 30; done
```

## Request SignalK data from MQTT

You can also request data from specific paths from SignalK, as a one-time request. To do so publish a message with the read topic prefix (`R/...`) with an empty payload. Remember to be subscribed to a matching topic to receive the data.

```bash
mosquitto_sub -t 'N/signalk/4881db477e55/vessels/self/#'

# in a separate terminal
mosquitto_pub -m '' -t 'R/signalk/4881db477e55/vessels/self/environment/depth/belowKeel'
```

## Send deltas to SignalK via MQTT

To send deltas to SignalK via MQTT, publish a message with the `D/` topic prefix, with the delta value as payload. For example:

```bash
mosquitto_pub -m '10' -t 'D/signalk/4881db477e55/vessels/self/environment/wind/speedApparent'
```

## Send PUT requests to SignalK via MQTT

To send PUT requests to SignalK via MQTT, publish a message with the `P/` topic prefix, with the PUT value as payload. For example:

```bash
mosquitto_pub -m '1' -t 'P/signalk/4881db477e55/vessels/self/electrical/switches/anchorLight/state'
```
