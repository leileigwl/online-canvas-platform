#!/bin/sh
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"
sed "s/__S3_BUCKET__/$S3_BUCKET/g" /config/flowcanvas-assets.json > /tmp/flowcanvas-assets.json

if ! mc admin policy info local flowcanvas-assets >/dev/null 2>&1; then
	mc admin policy create local flowcanvas-assets /tmp/flowcanvas-assets.json
fi
if ! mc admin user info local "$S3_ACCESS_KEY" >/dev/null 2>&1; then
	mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
fi
mc admin policy attach local flowcanvas-assets --user "$S3_ACCESS_KEY"
