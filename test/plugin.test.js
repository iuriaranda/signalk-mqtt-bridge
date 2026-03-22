const { expect } = require('chai');
const mqtt = require('mqtt');
const pluginFactory = require('../index');
const { createAppMock } = require('./helpers/appMock');
const { startBroker } = require('./helpers/brokerSetup');

const SELF_ID = 'urn:mrn:signalk:uuid:2bb1928e-3118-415e-b242-4881db477e55';
const SYSTEM_ID = '4881db477e55';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 3000, interval = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(interval);
  }
  throw new Error('Timed out waiting for condition');
}

describe('signalk-mqtt-bridge', function () {
  this.timeout(5000);

  let brokerCtx, testClient, messages;

  before(async function () {
    brokerCtx = await startBroker();
    testClient = mqtt.connect(brokerCtx.url);
    await new Promise(resolve => testClient.once('connect', resolve));
    testClient.subscribe('N/signalk/#');
    messages = [];
    testClient.on('message', (topic, payload) => {
      messages.push({ topic, payload: payload.toString() });
    });
  });

  after(async function () {
    await new Promise(resolve => testClient.end(false, resolve));
    await brokerCtx.stop();
  });

  beforeEach(function () {
    messages = [];
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function startPlugin(app, options = {}) {
    const plugin = pluginFactory(app);
    plugin.start({ mqttBrokerAddress: brokerCtx.url, keepaliveTtl: 60, ...options });
    await waitFor(() => app.setPluginStatus.calledWith('MQTT Connected'));
    return plugin;
  }

  // Publish a keepalive and wait for the plugin to process it
  async function sendKeepalive(topics) {
    const payload = Array.isArray(topics) ? JSON.stringify(topics) : '';
    testClient.publish(`R/signalk/${SYSTEM_ID}/keepalive`, payload);
    await delay(150);
  }

  function selfDelta(path, value = 1.0, extra = {}) {
    return { context: `vessels.${SELF_ID}`, path, value, $source: 'test', ...extra };
  }

  // ---------------------------------------------------------------------------
  // A. Initialization
  // ---------------------------------------------------------------------------

  describe('A. Initialization', function () {
    it('derives systemId from UUID selfId', function () {
      const app = createAppMock(SELF_ID);
      const plugin = pluginFactory(app);
      expect(plugin.systemId).to.equal(SYSTEM_ID);
    });

    it('derives systemId from MMSI selfId', function () {
      const app = createAppMock('urn:mrn:imo:mmsi:123456789');
      const plugin = pluginFactory(app);
      expect(plugin.systemId).to.equal('123456789');
    });

    it('calls app.error and app.setPluginError when selfId is undefined', function () {
      // Don't pass undefined to createAppMock — JS default params treat it as "not provided"
      const app = createAppMock();
      app.selfId = undefined;
      const plugin = pluginFactory(app);
      plugin.start({ mqttBrokerAddress: brokerCtx.url });
      expect(app.error.calledOnce).to.be.true;
      expect(app.setPluginError.calledOnce).to.be.true;
    });

    it('publishes N/<id>/keepalive = "1" and N/<id>/system/Serial on connect', async function () {
      const app = createAppMock(SELF_ID);
      const plugin = await startPlugin(app);
      try {
        await waitFor(() =>
          messages.some(m => m.topic === `N/signalk/${SYSTEM_ID}/keepalive` && m.payload === '1') &&
          messages.some(m => m.topic === `N/signalk/${SYSTEM_ID}/system/Serial` && m.payload === SYSTEM_ID)
        );
      } finally {
        plugin.stop();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // B. Keepalive flow
  // ---------------------------------------------------------------------------

  describe('B. Keepalive flow', function () {
    let app, plugin;

    beforeEach(async function () {
      app = createAppMock(SELF_ID);
      plugin = await startPlugin(app);
    });

    afterEach(function () {
      plugin.stop();
    });

    it('empty payload enables publishing for all topics', async function () {
      await sendKeepalive();
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround', 3.5));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
    });

    it('JSON array payload enables publishing only for specified topics', async function () {
      await sendKeepalive(['vessels/self/navigation/speedOverGround']);
      messages = [];

      // Subscribed path → published
      app._emitDelta(selfDelta('navigation.speedOverGround', 3.5));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));

      // Non-subscribed path → not published
      app._emitDelta(selfDelta('navigation.headingTrue', 1.0));
      await delay(200);
      expect(messages.filter(m => m.topic.includes('navigation/headingTrue'))).to.be.empty;
    });

    it('subscription is active immediately after keepalive', async function () {
      await sendKeepalive(['vessels/self/#']);
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround'));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
    });

    it('second keepalive for same topic does not cause duplicate publishes', async function () {
      await sendKeepalive(['vessels/self/#']);
      await sendKeepalive(['vessels/self/#']); // send again — should renew, not duplicate
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround'));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
      // Only one message per delta, regardless of how many keepalives were sent
      expect(messages.filter(m => m.topic.includes('navigation/speedOverGround'))).to.have.length(1);
    });

    it('keepalive for a different systemId is ignored', async function () {
      testClient.publish('R/signalk/wrongId/keepalive', '');
      await delay(200);
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround'));
      await delay(200);
      expect(messages.filter(m => m.topic.includes('navigation/speedOverGround'))).to.be.empty;
    });
  });

  // ---------------------------------------------------------------------------
  // C. Subscription expiry
  // ---------------------------------------------------------------------------

  describe('C. Subscription expiry', function () {
    this.timeout(6000);

    it('subscription expires after keepaliveTtl seconds and stops publishing', async function () {
      const app = createAppMock(SELF_ID);
      const plugin = await startPlugin(app, { keepaliveTtl: 1 });
      try {
        await sendKeepalive(['vessels/self/#']);
        // expires = now+1; expiry check is strict (<), so the 1s interval removes it at now+2
        await delay(2500);
        messages = [];
        app._emitDelta(selfDelta('navigation.speedOverGround'));
        await delay(200);
        expect(messages.filter(m => m.topic.includes('navigation/speedOverGround'))).to.be.empty;
      } finally {
        plugin.stop();
      }
    });

    it('subscription renewed before expiry persists past original expiry', async function () {
      const app = createAppMock(SELF_ID);
      const plugin = await startPlugin(app, { keepaliveTtl: 1 });
      try {
        await sendKeepalive(['vessels/self/#']); // expires = T+1
        // Cross a 1-second boundary so the renewal sets a later expiry
        await delay(1200);
        await sendKeepalive(['vessels/self/#']); // renew: expires = (T+1)+1 = T+2
        // Wait past where the original would have expired (~T+2s)
        await delay(1200); // now ~T+2.6s; renewed subscription lives until ~T+3s
        messages = [];
        app._emitDelta(selfDelta('navigation.speedOverGround'));
        await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
      } finally {
        plugin.stop();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // D. Delta publishing: SignalK → MQTT
  // ---------------------------------------------------------------------------

  describe('D. Delta publishing: SignalK → MQTT', function () {
    let app, plugin;

    beforeEach(async function () {
      app = createAppMock(SELF_ID);
      plugin = await startPlugin(app);
    });

    afterEach(function () {
      if (plugin) { plugin.stop(); plugin = null; }
    });

    it('self-vessel delta published to N/<id>/vessels/self/<path>', async function () {
      await sendKeepalive();
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround', 3.5));
      await waitFor(() => messages.some(m => m.topic === `N/signalk/${SYSTEM_ID}/vessels/self/navigation/speedOverGround`));
    });

    it('published payload contains only value, $source, timestamp, isMeta fields', async function () {
      await sendKeepalive();
      messages = [];
      app._emitDelta({ context: `vessels.${SELF_ID}`, path: 'navigation.speedOverGround', value: 3.5, $source: 'gps.1', timestamp: '2024-01-01T00:00:00Z', extra: 'ignored' });
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
      const parsed = JSON.parse(messages.find(m => m.topic.includes('navigation/speedOverGround')).payload);
      expect(parsed).to.have.keys(['value', '$source', 'timestamp']);
      expect(parsed).to.not.have.property('extra');
      expect(parsed).to.not.have.property('context');
      expect(parsed).to.not.have.property('path');
    });

    it('non-self vessel delta published to N/<id>/vessels/<otherId>/<path>', async function () {
      await sendKeepalive();
      messages = [];
      const otherId = 'urn:mrn:signalk:uuid:other-vessel-id';
      app._emitDelta({ context: `vessels.${otherId}`, path: 'navigation.speedOverGround', value: 5.0, $source: 'ais' });
      const expectedTopic = `N/signalk/${SYSTEM_ID}/vessels/${otherId}/navigation/speedOverGround`;
      await waitFor(() => messages.some(m => m.topic === expectedTopic));
    });

    it('delta with no active subscription is NOT published', async function () {
      // No sendKeepalive — no subscriptions active
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround', 3.5));
      await delay(200);
      expect(messages.filter(m => m.topic.includes('navigation/speedOverGround'))).to.be.empty;
    });

    it('malformed delta calls app.debug with "Malformed" and is not published', async function () {
      await sendKeepalive();
      messages = [];
      app._emitDelta({ notContext: 'bad' });
      await delay(100);
      expect(app.debug.args.some(args => args[0] && args[0].includes('Malformed'))).to.be.true;
      expect(messages.filter(m => m.topic.startsWith(`N/signalk/${SYSTEM_ID}/vessels`))).to.be.empty;
    });
  });

  // ---------------------------------------------------------------------------
  // E. Topic wildcard matching (via delta publishing)
  // ---------------------------------------------------------------------------

  describe('E. Topic wildcard matching', function () {
    let app, plugin;

    beforeEach(async function () {
      app = createAppMock(SELF_ID);
      plugin = await startPlugin(app);
    });

    afterEach(function () {
      plugin.stop();
    });

    it('# matches any trailing segments', async function () {
      await sendKeepalive(['vessels/self/#']);
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround'));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
    });

    it('+ matches exactly one segment', async function () {
      await sendKeepalive(['vessels/self/navigation/+']);
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround'));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
    });

    it('+ does NOT match two segments', async function () {
      await sendKeepalive(['vessels/self/navigation/+']);
      messages = [];
      app._emitDelta(selfDelta('navigation.position.latitude'));
      await delay(200);
      expect(messages.filter(m => m.topic.includes('navigation/position/latitude'))).to.be.empty;
    });

    it('exact match works', async function () {
      await sendKeepalive(['vessels/self/navigation/speedOverGround']);
      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround'));
      await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
    });

    it('exact match does NOT match a different path', async function () {
      await sendKeepalive(['vessels/self/navigation/speedOverGround']);
      messages = [];
      app._emitDelta(selfDelta('navigation.headingTrue'));
      await delay(200);
      expect(messages.filter(m => m.topic.includes('navigation/headingTrue'))).to.be.empty;
    });
  });

  // ---------------------------------------------------------------------------
  // F. Write handling: MQTT → SignalK
  // ---------------------------------------------------------------------------

  describe('F. Write handling: MQTT → SignalK', function () {
    let app, plugin;

    beforeEach(async function () {
      app = createAppMock(SELF_ID);
      plugin = await startPlugin(app);
    });

    afterEach(function () {
      plugin.stop();
    });

    it('W/<id>/vessels/self/<path> with numeric payload calls app.handleMessage with correct args', async function () {
      testClient.publish(`W/signalk/${SYSTEM_ID}/vessels/self/navigation/speedOverGround`, '3.5');
      await waitFor(() => app.handleMessage.calledOnce);
      const [pluginId, delta] = app.handleMessage.firstCall.args;
      expect(pluginId).to.equal('signalk-mqtt-bridge');
      expect(delta.context).to.equal(`vessels.${SELF_ID}`);
      expect(delta.updates[0].$source).to.equal('mqtt');
      expect(delta.updates[0].values[0].path).to.equal('navigation.speedOverGround');
      expect(delta.updates[0].values[0].value).to.equal(3.5);
    });

    it('non-numeric payload is passed through as string', async function () {
      testClient.publish(`W/signalk/${SYSTEM_ID}/vessels/self/environment/description`, 'calm');
      await waitFor(() => app.handleMessage.calledOnce);
      expect(app.handleMessage.firstCall.args[1].updates[0].values[0].value).to.equal('calm');
    });

    it('first argument to app.handleMessage is the plugin id', async function () {
      testClient.publish(`W/signalk/${SYSTEM_ID}/vessels/self/navigation/speedOverGround`, '1');
      await waitFor(() => app.handleMessage.calledOnce);
      expect(app.handleMessage.firstCall.args[0]).to.equal('signalk-mqtt-bridge');
    });

    it('subpath with fewer than 3 parts does NOT call app.handleMessage', async function () {
      testClient.publish(`W/signalk/${SYSTEM_ID}/vessels/self`, '42');
      await delay(200);
      expect(app.handleMessage.called).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // G. PUT handling: MQTT → SignalK
  // ---------------------------------------------------------------------------

  describe('G. PUT handling: MQTT → SignalK', function () {
    let app, plugin;

    beforeEach(async function () {
      app = createAppMock(SELF_ID);
      plugin = await startPlugin(app);
    });

    afterEach(function () {
      plugin.stop();
    });

    it('P/<id>/vessels/self/<path> calls app.putSelfPath with correct path and value', async function () {
      testClient.publish(`P/signalk/${SYSTEM_ID}/vessels/self/navigation/speedOverGround`, '5.5');
      await waitFor(() => app.putSelfPath.calledOnce);
      const [path, value] = app.putSelfPath.firstCall.args;
      expect(path).to.equal('navigation.speedOverGround');
      expect(value).to.equal(5.5);
    });

    it('P/<id>/vessels/<otherId>/<path> calls app.putPath', async function () {
      testClient.publish(`P/signalk/${SYSTEM_ID}/vessels/other123/navigation/speedOverGround`, '2.0');
      await waitFor(() => app.putPath.calledOnce);
      const [path, value] = app.putPath.firstCall.args;
      expect(path).to.equal('vessels.other123.navigation.speedOverGround');
      expect(value).to.equal(2.0);
    });

    it('non-numeric payload is passed through as string', async function () {
      testClient.publish(`P/signalk/${SYSTEM_ID}/vessels/self/environment/mode`, 'anchored');
      await waitFor(() => app.putSelfPath.calledOnce);
      expect(app.putSelfPath.firstCall.args[1]).to.equal('anchored');
    });
  });

  // ---------------------------------------------------------------------------
  // H. Plugin stop / cleanup
  // ---------------------------------------------------------------------------

  describe('H. Plugin stop / cleanup', function () {
    it('deltas emitted after stop are NOT published', async function () {
      const app = createAppMock(SELF_ID);
      const plugin = await startPlugin(app);
      await sendKeepalive();
      plugin.stop();
      await delay(200); // wait for MQTT client to disconnect

      messages = [];
      app._emitDelta(selfDelta('navigation.speedOverGround', 9.9));
      await delay(200);
      expect(messages.filter(m => m.topic.includes('navigation/speedOverGround'))).to.be.empty;
    });

    it('after stop and restart, plugin publishes deltas normally', async function () {
      const app1 = createAppMock(SELF_ID);
      const plugin1 = await startPlugin(app1);
      await sendKeepalive();
      plugin1.stop();
      await delay(200);

      const app2 = createAppMock(SELF_ID);
      const plugin2 = await startPlugin(app2);
      try {
        await sendKeepalive();
        messages = [];
        app2._emitDelta(selfDelta('navigation.speedOverGround', 5.0));
        await waitFor(() => messages.some(m => m.topic.includes('navigation/speedOverGround')));
      } finally {
        plugin2.stop();
      }
    });
  });
});
