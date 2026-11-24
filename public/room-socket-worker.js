importScripts('/socket.io/socket.io.js');

// The transport handles Engine.IO ping/pong here, independently of DOM work.
const connection = io(self.location.origin, { autoConnect: false });
const forward = (event, ...args) => self.postMessage([event, ...args]);
connection.onAny(forward);
connection.on('connect', () => forward('connect'));
connection.on('disconnect', reason => forward('disconnect', reason));
self.onmessage = ({data: [event, ...args]}) => connection.emit(event, ...args);
connection.connect();
