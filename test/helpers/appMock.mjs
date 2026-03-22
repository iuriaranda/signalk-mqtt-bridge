import sinon from 'sinon';
import { EventEmitter } from 'events';

function createAppMock(selfId = 'urn:mrn:signalk:uuid:2bb1928e-3118-415e-b242-4881db477e55') {
  const bus = new EventEmitter();
  bus.onValue = function (cb) {
    bus.on('value', cb);
    return function unsubscribe() { bus.off('value', cb); };
  };

  return {
    selfId,
    streambundle: { getBus: sinon.stub().returns(bus) },
    debug: sinon.stub(),
    error: sinon.stub(),
    setPluginStatus: sinon.stub(),
    setPluginError: sinon.stub(),
    handleMessage: sinon.stub(),
    putSelfPath: sinon.stub(),
    putPath: sinon.stub(),
    getSelfPath: sinon.stub().returns(undefined),
    getPath: sinon.stub().returns(undefined),
    _bus: bus,
    _emitDelta: (delta) => bus.emit('value', delta),
  };
}

export { createAppMock };
