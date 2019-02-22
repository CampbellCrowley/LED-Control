const net = require('net');
const portAudio = require('naudiodon');
const Analyser = require('audio-analyser');

const DEBUG = false;

// Number of LEDs total to control.
const numLEDs = 150;
// The number of LEDs for each calculated value.
const precision = 1;

const colors = ['FF0000', 'FF9400', 'FFFF00', '0FAD00', '0010A5', 'C5007C'];

// Time in milliseconds at which to send the data to the server.
const timeDelay = 33;
// Number of times faster to analyze the audio without sending LED data.
const speedMult = 4;
// Audio sample rate, also used to calculate Hz ranges.
const sampleRate = 44100;

// FFT Size, also used to calculate Hz ranges.
const fftSize = 512;
const binCount = fftSize / 2;

const minHz = 20;
const maxHz = 20000;
const minDB = -95;
const maxDB = -20;

const binDelta = (sampleRate / 2) / binCount;

const minIndex = Math.ceil(minHz / binDelta);
const maxIndex = Math.floor(maxHz / binDelta);

// Audio device ID
const id = 36;
console.log(portAudio.getDevices().filter((el) => {
  return el.maxInputChannels > 0;
}).map((el) => {
  return `id: ${el.id} (${el.name})`;
}).join('\n'));

let interval;
let count = 0;
let data = new Float32Array(binCount);

let history = [];
let peakHistory = [1.0];
let beatHistory = [0];
let prevWrite = new Array(Math.ceil(numLEDs / precision));
let lastBeat = false;
let now = 0;
let realNow = Date.now();

let low = true;
let curColorIndex = 0;
let thresh = 0.2;
let lowAccumulator = 0;
let mode = 0;
const numModes = 3;

let analyser = new Analyser({
  fftSize: fftSize,
  smoothingTimeConstant: 0.1,
  frequencyBinCount: binCount,
  minDecibels: minDB,
  maxDecibles: maxDB,
  channel: 0,
  bufferSize: sampleRate,
});

let audio = new portAudio.AudioInput({
  channelCount: 1,
  sampleFormat: portAudio.SampleFormat16Bit,
  sampleRate: sampleRate,
  deviceId: id,
});

audio.on('error', err => console.error);

audio.pipe(analyser);
audio.start();

process.stdin.on('data', (line) => {
  mode = ++mode % numModes;
  process.stdout.write('CHANGED MODE TO: ' + mode);
});

let client = new net.Socket();
function connect() {
 client.connect(81, '192.168.0.203');
}
connect();

client.on('connect', () => {
  console.log('Server Connected!');

  client.write(';rainbow 1;render;');

  if (interval) clearInterval(interval);
  interval = setInterval(() => {
    count++;
    switch (mode) {
      case 1:
        rainbowRotateStep();
        return;
      case 2:
        colorShiftStep();
        return;
      default:
        break;
    }
    analyser.getFloatFrequencyData(data);

    let sum = 0;
    let adjSum = 0;
    let anyWrite = false;
    for (let i = 0; i < numLEDs; i += precision) {
      let pPercent = (i - precision) / numLEDs;
      let nPercent = (i + precision) / numLEDs;
      let pIndex = lerp(minIndex, maxIndex, pPercent);
      let nIndex = lerp(minIndex, maxIndex, nPercent);

      let pBin = Math.max(minIndex, Math.floor(pIndex));
      let nBin = Math.min(maxIndex, Math.ceil(nIndex));

      let value = 0;

      for (let j = pBin; j < nBin; j++) {
        value += data[j];
      }
      value /= (nBin - pBin) || 1;
      value -= minDB;
      value /= (maxDB - minDB);

      let val = Math.round(value * 255);

      if (i < numLEDs / 2) {
        adjSum += value;
      }
      sum += value;

      if (count % speedMult == 0) {
        if (prevWrite[i] > val) {
          val = Math.max(prevWrite[i] - 5, 0);
        }
        if (prevWrite[i] != val) {
          anyWrite = true;
        }
        client.write(
            `brightness 1,${val},${numLEDs - i - precision},${precision};`);
        prevWrite[i] = val;
      }
    }
    let realAvg = sum / numLEDs / precision * 2;
    let avg = (adjSum / (numLEDs / 2) / precision) * 2;
    history.push(avg);
    let totalChange = 0;
    for (let i = 1; i < history.length; i++) {
      let d = history[i] - history[i - 1];
      totalChange += d > 0 ? d : 0;
    }

    totalChange = Math.pow(totalChange, 2);
    let isPeak = totalChange > 0.05;

    let isBeat = avg > 0.2 && totalChange > thresh;

    if (avg > 0.2) {
      now += Date.now() - realNow;
    }
    realNow = Date.now();
    if (isPeak && !lastBeat) {
      beatHistory.push({val: totalChange, time: now});
      peakHistory.push(totalChange);
      if (peakHistory.length > 100) {
        peakHistory.splice(0, 1);
      }
    }

    if (isBeat && !lastBeat) {
      curColorIndex = (curColorIndex + 1) % colors.length;
      let color = colors[curColorIndex];
      client.write(`fill 1,${color};`);
      low = false;
      lowAccumulator = 0;
    }

    if (avg < 0.1 && lowAccumulator >= 1000 / (timeDelay / speedMult)) {
      colorShiftStep();
    }

    if (count % speedMult == 0) {
      if (avg < 0.1) {
        lowAccumulator++;
        if (lowAccumulator >= 100 / (timeDelay / speedMult)) {
          if (!low) {
            client.write('rainbow 1;');
            r = 0;
            g = 0;
            b = 0;
          }
          low = true;
        }
      }
      if (anyWrite) {
        client.write('render;');
        client.write('rotate 1,1;');
      }
    }

    if (DEBUG) {
      // let inc = 0.004;
      let inc = 0.005;
      for (let i = 0; i < 1; i += inc) {
        if (totalChange <= i && totalChange > i - inc) {
          process.stdout.write('X');
        } else if (thresh <= i && thresh > i - inc) {
          process.stdout.write('|');
        } else if (i < realAvg){
          process.stdout.write((isBeat && !lastBeat) ? '/' : '-');
        } else {
          process.stdout.write(isPeak ? ' ' : '_');
        }
        // else process.stdout.write('_');
      }
    }

    let dur = 8;
    beatHistory = beatHistory.filter((el) => now - el.time <= dur * 1000);

    let bpm;
    let newThresh = thresh;
    // Goal number of times per minute to change color. (kinda bpm)
    const goal = 60;
    let numLastSec =
        beatHistory.reduce((a, c) => c.val >= newThresh ? a + 1 : a, 0);
    bpm = Math.round(numLastSec / dur * 60);
    let tries = 0;
    let diff = (bpm - goal) / (goal * 10);
    let mag = diff > 0 ? 1 : -1;
    diff = Math.abs(diff);
    diff = diff * (diff * 2) * (diff * 3);
    newThresh += diff * mag;
    numLastSec =
        beatHistory.reduce((a, c) => c.val >= newThresh ? a + 1 : a, 0);
    bpm = Math.round(numLastSec / dur * 60);
    thresh = newThresh;

    if (thresh < 0.05) thresh = 0.05;
    if (thresh > 1) thresh = 1;

    if (DEBUG) {
      process.stdout.write(bpm + ' ' + Math.round(thresh*10000)/10000 + '\n');
    }

    lastBeat = isBeat;
    if (history.length > 5) history.splice(0, 1);
  }, timeDelay / speedMult);
});

function rainbowRotateStep() {
  if (count % (speedMult * 4) == 0) {
    client.write('brightness 1,255;rainbow 1;rotate 1,' +
                 Math.floor(count / speedMult) % numLEDs + ';render;');
  }
}

let r = 0;
let g = 0;
let b = 0;
function colorShiftStep() {
  if (count % (speedMult * 4) == 0) {
    if (r + g + b != 255) {
      if (r > 255) {
        r--;
      } else if (r < 255) {
        r++;
      }
      if (g > 0) {
        g--;
      } else if (g < 0) {
        g++;
      }
      if (b > 0) {
        b--;
      } else if (b < 0) {
        b++;
      }
    } else if (r > 0 && b == 0) {
      r--;
      g++;
    } else if (g > 0 && r == 0) {
      g--;
      b++;
    } else if (b > 0 && g == 0) {
      r++;
      b--;
    }
    const color = ('0' + r.toString(16)).slice(-2) +
                  ('0' + g.toString(16)).slice(-2) +
                  ('0' + b.toString(16)).slice(-2);
    client.write('brightness 1,255;fill 1,' + color + ';render;');
    // console.log(color);
  }
}

function lerp(a, b, n) {
  return a * (1 - n) + b * n
}

client.on('data', (data) => {
  console.log(data);
});

client.on('close', () => {
  console.log('Server Connection closed');
  if (interval) clearInterval(interval);
  if (!exiting) connect();
  else process.exit();
});

client.on('error', (err) => {
  console.error(err);
});

client.on('finish', () => {
  console.log('Closing socket...');
  if (interval) clearInterval(interval);
  client.destroy();
});

let exiting = false;
process.on('exit', onExit);
process.on('SIGINT', onExit);
process.on('SIGTERM', onExit);
process.on('SIGHUP', onExit);
function onExit() {
  exiting = true;
  console.log('Exiting...');
  process.removeListener('exit', onExit);
  process.removeListener('SIGINT', onExit);
  process.removeListener('SIGTERM', onExit);
  process.removeListener('SIGHUP', onExit);
  audio.quit();
  if (interval) clearInterval(interval);
  if (client.writable) {
    client.write(';fill 1,000000;render;');
    client.end();
    console.log('Flushing data...');
  } else {
    process.exit();
  }
}
