'use strict';

// Storage abstraction: local disk (default) or S3-compatible (MinIO, R2, AWS S3).
// Set S3_BUCKET to enable S3. If S3 is enabled, install the optional packages:
//   npm install @aws-sdk/client-s3 multer-s3
//
// When using S3, files are served via redirect (public bucket or CDN via S3_PUBLIC_URL).
// For private buckets you would swap the redirect for a presigned URL.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { randomHex } = require('../utils');

const useS3 = !!config.s3.bucket;

let _s3Client = null;
function s3Client() {
  if (_s3Client) return _s3Client;
  let S3Client;
  try {
    ({ S3Client } = require('@aws-sdk/client-s3'));
  } catch {
    throw new Error('S3_BUCKET is set but @aws-sdk/client-s3 is not installed. Run: npm install @aws-sdk/client-s3 multer-s3');
  }
  _s3Client = new S3Client({
    region: config.s3.region,
    ...(config.s3.endpoint && { endpoint: config.s3.endpoint, forcePathStyle: true }),
    ...(process.env.AWS_ACCESS_KEY_ID && {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    }),
  });
  return _s3Client;
}

/** Returns a multer storage engine appropriate for the current config. */
function makeMulterStorage(multer) {
  if (!useS3) {
    return multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, randomHex(16)),
    });
  }
  let multerS3;
  try {
    multerS3 = require('multer-s3');
  } catch {
    throw new Error('S3_BUCKET is set but multer-s3 is not installed. Run: npm install @aws-sdk/client-s3 multer-s3');
  }
  return multerS3({
    s3: s3Client(),
    bucket: config.s3.bucket,
    key: (req, file, cb) => cb(null, `uploads/${randomHex(16)}`),
    contentDisposition: 'attachment',
  });
}

/** Get the stored name (DB column) from a multer file object. */
function storedNameOf(file) {
  return useS3 ? file.key : file.filename;
}

/** Delete a stored file (fire-and-forget). */
function deleteFile(storedName) {
  if (!useS3) {
    fs.rm(path.join(config.uploadDir, storedName), { force: true }, () => {});
    return;
  }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  s3Client().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: storedName })).catch(() => {});
}

/** Discard files from a failed multer upload (no-op for S3 — multer-s3 handles it). */
function discardFiles(files) {
  if (useS3) return;
  for (const f of files || []) fs.rm(f.path, { force: true }, () => {});
}

/** Stream a file to the response, or redirect to its S3/CDN URL. */
function serveFile(res, storedName, displayName) {
  if (!useS3) {
    res.download(path.join(config.uploadDir, storedName), displayName);
    return;
  }
  const base = (config.s3.publicUrl || `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`).replace(/\/$/, '');
  res.redirect(307, `${base}/${storedName}`);
}

module.exports = { useS3, makeMulterStorage, storedNameOf, deleteFile, discardFiles, serveFile };
