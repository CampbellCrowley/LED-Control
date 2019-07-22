const net = require('net');
let client = new net.Socket();
client.connect(81, '192.168.0.203');
client.on('connect', () => {
  console.log('Connected');
  client.write(';fill 1,000000;render;');
  console.log('Flushing...');
  client.end();
});
client.on('finish', () => {
  console.log('Finished');
  client.destroy();
});
client.on('close', () => {
  console.log('Connection Closed');
  process.exit();
});
