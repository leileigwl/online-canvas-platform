FROM alpine:3.22 AS download

ARG TARGETARCH
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z

RUN apk add --no-cache ca-certificates wget
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) checksum=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891 ;; \
      arm64) checksum=14c8c9616cfce4636add161304353244e8de383b2e2752c0e9dad01d4c27c12c ;; \
      *) echo "Unsupported mc architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    binary="mc.linux-${TARGETARCH}.${MC_VERSION}"; \
    wget -q -O /usr/local/bin/mc "https://github.com/minio/mc/releases/download/${MC_VERSION}/${binary}"; \
    echo "${checksum}  /usr/local/bin/mc" | sha256sum -c -; \
    chmod +x /usr/local/bin/mc

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=download /usr/local/bin/mc /usr/local/bin/mc
COPY infra/minio-init.sh /usr/local/bin/minio-init
RUN chmod +x /usr/local/bin/minio-init

ENTRYPOINT ["mc"]
