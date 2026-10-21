import test from 'node:test';
import assert from 'node:assert/strict';
import { presignUrl, r2 } from '../lib/r2.js';

test('SigV4 presigner matches the official AWS documentation example', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const url = presignUrl({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.ok(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'));
});

test('R2 URLs: path-style, region auto, disabled without env, method is part of the signature', () => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT_HOST']) delete process.env[k];
  assert.equal(r2.enabled(), false);
  assert.throws(() => r2.presign('PUT', 'u/abc'), /not configured/);
  Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: 'SECRET', R2_BUCKET: 'sharebin' });
  try {
    assert.equal(r2.enabled(), true);
    const put = new URL(r2.presign('PUT', 'u/0123abcd', 300));
    const get = new URL(r2.presign('GET', 'u/0123abcd', 300));
    assert.equal(put.host, 'acct123.r2.cloudflarestorage.com');
    assert.equal(put.pathname, '/sharebin/u/0123abcd');
    assert.ok(put.searchParams.get('X-Amz-Credential').endsWith('/auto/s3/aws4_request'));
    assert.equal(put.searchParams.get('X-Amz-Expires'), '300');
    assert.notEqual(put.searchParams.get('X-Amz-Signature'), get.searchParams.get('X-Amz-Signature'));
    process.env.R2_ENDPOINT_HOST = 'acct123.eu.r2.cloudflarestorage.com';
    assert.equal(new URL(r2.presign('GET', 'u/x')).host, 'acct123.eu.r2.cloudflarestorage.com');
  } finally {
    for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT_HOST']) delete process.env[k];
  }
});
