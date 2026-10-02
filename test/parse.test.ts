import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalTarget, isPrivate, parseHostPort } from '../src/core/net-utils';
import { parseProxyLine, parseProxyList } from '../src/core/parse';
import { citySlug, dataImpulse } from '../src/core/providers/dataimpulse';
import { ipv6ToBytes } from '../src/core/upstream';

test('parses the common proxy formats', () => {
  assert.deepEqual(parseProxyLine('http://user:pa:ss@1.2.3.4:8080'), {
    protocol: 'http',
    host: '1.2.3.4',
    port: 8080,
    username: 'user',
    password: 'pa:ss',
    provider: null,
  });
  assert.equal(parseProxyLine('socks5://u:p@proxy.example.com:1080')?.protocol, 'socks5');
  assert.deepEqual(
    { ...parseProxyLine('proxy.example.com:3128:alice:secret') },
    { protocol: 'http', host: 'proxy.example.com', port: 3128, username: 'alice', password: 'secret', provider: null },
  );
  assert.equal(parseProxyLine('alice:secret:proxy.example.com:3128')?.host, 'proxy.example.com');
  assert.equal(parseProxyLine('10.0.0.5:8888')?.port, 8888);
  assert.equal(parseProxyLine('not a proxy'), null);
  assert.equal(parseProxyLine('ftp://a:b@c:21'), null);
  assert.equal(parseProxyLine('host:99999'), null);
});

test('detects DataImpulse and pulls targeting out of the login', () => {
  const p = parseProxyLine('abc123__cr.in;city.mumbai;sessid.x:pw@gw.dataimpulse.com:823');
  assert.equal(p?.provider, 'dataimpulse');
  assert.equal(p?.username, 'abc123');
  assert.equal(p?.country, 'in');
  assert.equal(p?.city, 'mumbai');
  assert.equal(p?.password, 'pw');
});

test('builds DataImpulse logins', () => {
  assert.equal(dataImpulse.buildLogin('abc', {}), 'abc');
  assert.equal(dataImpulse.buildLogin('abc', { country: 'IN' }), 'abc__cr.in');
  assert.equal(dataImpulse.buildLogin('abc', { country: 'us', city: 'New York', session: 's1', sessionMinutes: 60 }), 'abc__cr.us;city.newyork;sessid.s1;sessttl.60');
  assert.equal(dataImpulse.buildLogin('abc', { sessionMinutes: 60 }), 'abc', 'sessttl only applies to sticky sessions');
  assert.equal(citySlug('São Paulo'), 'saopaulo');
});

test('splits pasted lists and reports bad lines', () => {
  const { parsed, invalid } = parseProxyList('# comment\n1.1.1.1:80\n\ngarbage\nu:p@h.example:1');
  assert.equal(parsed.length, 2);
  assert.deepEqual(invalid, ['garbage']);
});

test('address helpers', () => {
  assert.equal(isPrivate('192.168.1.20'), true);
  assert.equal(isPrivate('100.101.1.2'), true, 'Tailscale CGNAT range');
  assert.equal(isPrivate('8.8.8.8'), false);
  assert.equal(isPrivate('::ffff:10.1.2.3'), true);
  assert.equal(isLocalTarget('printer.local'), true);
  assert.equal(isLocalTarget('example.com'), false);
  assert.deepEqual(parseHostPort('[::1]:443'), { host: '::1', port: 443 });
  assert.deepEqual(parseHostPort('example.com', 443), { host: 'example.com', port: 443 });
  assert.equal(ipv6ToBytes('::1').toString('hex'), '00000000000000000000000000000001');
  assert.equal(ipv6ToBytes('2001:db8::8a2e:370:7334').toString('hex'), '20010db80000000000008a2e03707334');
  assert.equal(ipv6ToBytes('::ffff:1.2.3.4').toString('hex'), '00000000000000000000ffff01020304');
});
