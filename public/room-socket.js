function createRoomSocket() {
  if (typeof Worker === 'undefined') return io();
  let worker;
  try {
    worker = new Worker('/room-socket-worker.js');
  } catch {
    return io();
  }

  const listeners = new Map();
  let fallback;
  let connected = false;
  function dispatch(event, ...args) {
    if (event === 'connect') connected = true;
    if (event === 'disconnect') connected = false;
    for (const listener of listeners.get(event) || []) listener(...args);
  }
  worker.onmessage = ({data}) => dispatch(...data);
  worker.onerror = () => {
    worker.terminate();
    if (connected) dispatch('disconnect', 'Worker stopped');
    fallback = io({ autoConnect: false });
    fallback.onAny(dispatch);
    fallback.on('connect', () => dispatch('connect'));
    fallback.on('disconnect', reason => dispatch('disconnect', reason));
    fallback.connect();
  };
  return {
    get connected() { return connected; },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    emit(event, ...args) {
      if (fallback) fallback.emit(event, ...args);
      else worker.postMessage([event, ...args]);
    }
  };
}
