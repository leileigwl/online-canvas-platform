FROM golang:1.24.8-alpine AS build

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ENV CGO_ENABLED=0
ENV GOPROXY=https://proxy.golang.org|https://goproxy.cn|direct
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MINIO_VERSION}" https://github.com/minio/minio.git /src/minio
WORKDIR /src/minio
RUN go mod download
RUN go build -o /out/minio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /usr/local/bin/minio

EXPOSE 9000 9001
ENTRYPOINT ["minio"]
