import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mask } from './mask.ts';

test('passwords in URLs go, the user and host stay', () => {
  assert.equal(mask('connecting to postgres://app:s3cr3t-Pw@db.internal:5432/shop'), 'connecting to postgres://app:***@db.internal:5432/shop');
  assert.equal(mask('GET https://admin:hunter2@nas.lan/api'), 'GET https://admin:***@nas.lan/api');
  assert.equal(mask('see https://example.org/a:b/c'), 'see https://example.org/a:b/c', 'a colon in a path is not a password');
});

test('bearer, basic and API keys', () => {
  assert.equal(mask('Authorization: Bearer abcDEF123456.xyz'), 'Authorization: Bearer ***');
  assert.equal(mask('auth header Basic dXNlcjpwYXNz'), 'auth header Basic ***');
  assert.equal(mask('X-Api-Key: 9f8e7d6c5b4a'), 'X-Api-Key: ***');
  assert.equal(mask('GET /hook?token=abc123&page=2'), 'GET /hook?token=***&page=2');
  assert.equal(mask('login failed password=Tr0ub4dor3 user=bob'), 'login failed password=*** user=bob');
  assert.equal(mask('Authorization: token 0123abcd'), 'Authorization: token ***');
  assert.equal(mask('api_key: "k-live-123"'), 'api_key: ***');
  assert.equal(mask('{"user":"bob","password":"pa ss","ok":true}'), '{"user":"bob","password":"***","ok":true}');
  assert.equal(mask('client_secret=abc; next'), 'client_secret=***; next');
});

test('well-known token formats, wherever they are', () => {
  const samples = [
    'ghp_' + 'A'.repeat(36),
    'github_pat_' + 'B1'.repeat(15),
    'glpat-' + 'x'.repeat(20),
    'xoxb-' + '1234567890-abcdef',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'AIza' + 'S'.repeat(35),
    'sk-ant-' + 'z'.repeat(30),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNhbXBsZQ',
  ];
  for (const s of samples) assert.equal(mask(`pushed with ${s} ok`), 'pushed with *** ok', s);
});

test('e-mail addresses and private keys', () => {
  assert.equal(mask('mail sent to jane.doe+news@example.co.uk'), 'mail sent to ***@***');
  assert.equal(mask('key -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1r -----END OPENSSH PRIVATE KEY----- done'), 'key *** private key *** done');
});

test('ordinary lines are left alone', () => {
  for (const s of ['GET /index.html 200 512', 'commit 3f2a9c1d4e5b6a7980 merged', 'token bucket refilled', 'basic setup finished', 'basic configuration done', 'Bearer of bad news', 'disk /dev/sda1 at 91 %', 'session started for user 1000']) {
    assert.equal(mask(s), s);
  }
});
