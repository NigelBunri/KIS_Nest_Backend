const { io } = require('socket.io-client');

function connect(name, token) {
  const s = io('http://localhost:4000', {
    path: '/ws',
    auth: { token },
  });
  s.on('connect', () => console.log(name, 'connected', s.id));
  s.on('chat.message', (m) => console.log(name, 'got message', m));
  s.on('typing', (t) => console.log(name, 'typing', t));
  return s;
}

// Replace with real JWTs after wiring Django; during dev you can temporarily bypass in WsAuthGuard.
const A = connect('A', 'JWT-FOR-A');
const B = connect('B', 'JWT-FOR-B');

setTimeout(() => {
  const conv = '11111111-1111-1111-1111-111111111111';
  A.emit('chat.join', { conversationId: conv });
  B.emit('chat.join', { conversationId: conv });
}, 500);

setTimeout(() => {
  A.emit('chat.send', {
    conversationId: '11111111-1111-1111-1111-111111111111',
    ciphertext: 'BASE64:CIPHERTEXT',
  }, (ack) => console.log('ACK', ack));
}, 1200);
