import test from 'ava';
import EventEmitter from 'events';
import http, { ClientRequest, IncomingMessage } from 'http';
import https from 'https';
import { AddressInfo } from 'net';
import pEvent from 'p-event';
import {
    parse as parseUrl,
    URL,
} from 'url';
import util from 'util';
import timer, { Timings } from './lib';

const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e6;

/**
 * Get duration in milliseconds from process.hrtime()
 * @function getHrTimeDurationInMs
 * @param {Array} time - [seconds, nanoseconds]
 * @return {Number} durationInMs
 */
const getHrTimeDurationInMs = (time: [number, number]): number =>
  (time[0] * NS_PER_SEC + time[1]) / MS_PER_NS;

let server: http.Server & {
  url?: string;
  listenAsync?: any;
  closeAsync?: any;
};

test.before('setup', async () => {
  server = http.createServer((_request, response) => {
    response.write('o');

    setTimeout(() => response.end('k'), 200);
  });

  server.listenAsync = util.promisify(server.listen.bind(server));
  server.closeAsync = util.promisify(server.close.bind(server));

  await server.listenAsync();
  server.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after('cleanup', async () => {
  await server.closeAsync();
});

const error = 'Simple error';

const makeRequest = (
  url = 'https://httpbin.org/anything'
): { request: ClientRequest; timings: Timings } => {
  const { protocol } = new URL(url);
  const fn = protocol === 'http:' ? http : https;

  const request = fn.get(url);
  const timings = timer(request);

  return { request, timings };
};

test('by default everything is set to undefined', t => {
  const { timings } = makeRequest();

  t.is(typeof timings, 'object');
  t.is(typeof timings.start, 'number');
  t.is(timings.socket, undefined);
  t.is(timings.dnsLookup, undefined);
  t.is(timings.connect, undefined);
  t.is(timings.response, undefined);
  t.is(timings.end, undefined);
  t.is(timings.error, undefined);
});

test('timings', async t => {
  const { request, timings } = makeRequest();
  const response = await pEvent(request, 'response');
  response.resume();
  await pEvent(response, 'end');

  t.is(typeof timings, 'object');
  t.is(typeof timings.start, 'number');
  t.is(typeof timings.socket, 'number');
  t.is(typeof timings.dnsLookup, 'number');
  t.is(typeof timings.connect, 'number');
  t.is(typeof timings.upload, 'number');
  t.is(typeof timings.response, 'number');
  t.is(typeof timings.end, 'number');
});

test('phases', async t => {
  const { request, timings } = makeRequest();
  const response = await pEvent(request, 'response');
  response.resume();
  await pEvent(response, 'end');

  t.is(typeof timings.phases, 'object');
  t.is(typeof timings.phases.wait, 'number');
  t.is(typeof timings.phases.dns, 'number');
  t.is(typeof timings.phases.tcp, 'number');
  t.is(typeof timings.phases.firstByte, 'number');
  t.is(typeof timings.phases.download, 'number');
  t.is(typeof timings.phases.total, 'number');

  t.is(timings.phases.wait, timings.socket! - timings.start);
  t.is(timings.phases.dns, timings.dnsLookup! - timings.socket!);
  t.is(timings.phases.tcp, timings.connect! - timings.dnsLookup!);
  t.is(timings.phases.request, timings.upload! - timings.connect!);
  t.is(timings.phases.firstByte, timings.response! - timings.upload!);
  t.is(timings.phases.download, timings.end! - timings.response!);
  t.is(timings.phases.total, timings.end! - timings.start);
});

test('no memory leak (`lookup` event)', async t => {
  const { request } = makeRequest();

  await pEvent(request, 'finish');

  t.is(request.socket.listenerCount('lookup'), 0);
});

test('sets `total` on request error', async t => {
  const request = http.get({
    hash: '',
    href: '',
    pathname: '',
    search: '',
    timeout: 1,
    ...parseUrl(server.url!),
  });
  request.on('timeout', () => {
    request.abort();
  });

  const timings = timer(request);

  const err: Error = await pEvent(request, 'error');
  t.is(err.message, 'socket hang up');

  t.is(typeof timings.error, 'number');
  t.is(timings.phases.total, timings.error! - timings.start);
});

test('sets `total` on response error', async t => {
  const request = http.get(server.url!, (response: IncomingMessage) => {
    setImmediate(() => {
      response.emit('error', new Error(error));
    });
  });
  const timings = timer(request);

  const response = await pEvent(request, 'response');
  const err: Error = await pEvent(response, 'error');

  t.is(err.message, error);
  t.is(typeof timings.error, 'number');
  t.is(timings.phases.total, timings.error! - timings.start);
});

test('doesn\'t throw when someone used `.prependOnceListener()`', async t => {
  const emitter = new EventEmitter();
  timer(emitter as ClientRequest);
  emitter.prependOnceListener('error', () => {});

  await t.notThrows(() => emitter.emit('error', new Error(error)));
});

test('sensible timings', async t => {
  const { timings, request } = makeRequest('http://google.com');
  const now = getHrTimeDurationInMs(process.hrtime());

  const response = await pEvent(request, 'response');
  response.resume();
  await pEvent(response, 'end');

  t.true(timings.socket! >= now);
  t.true(timings.dnsLookup! >= now);
  t.true(timings.connect! >= now);
  t.true(timings.response! >= now);
  t.true(timings.end! >= now);
  t.is(timings.error, undefined);
  t.true(timings.phases.wait! < 1000);
  t.true(timings.phases.dns! < 1000);
  t.true(timings.phases.tcp! < 1000);
  t.true(timings.phases.request! < 1000);
  t.true(timings.phases.firstByte! < 1000);
  t.true(timings.phases.download! < 1000);
  t.true(timings.phases.total! < 1000);
});
