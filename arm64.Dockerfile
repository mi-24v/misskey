FROM node:16.6.2-alpine3.13 AS base

ENV NODE_ENV=production

WORKDIR /misskey

ENV BUILD_DEPS autoconf automake file g++ gcc libc-dev libtool make nasm pkgconfig python3 zlib-dev git

FROM base AS builder

# sharp 0.28.0 でarm64v8のprebuiltバイナリが出るので下記は不要になるかもしれない
# https://github.com/lovell/sharp/issues/2498
RUN apk add libimagequant-dev --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main
RUN apk add vips-dev --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community

RUN apk add --no-cache $BUILD_DEPS && \
    git submodule update --init && \
    yarn install && \
    yarn build && \
    rm -rf .git

FROM base AS runner

RUN apk add --no-cache \
    ffmpeg \
    tini \

ENTRYPOINT ["/sbin/tini", "--"]

COPY --from=builder /misskey/node_modules ./node_modules
COPY --from=builder /misskey/built ./built
COPY --from=builder /misskey/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=builder /misskey/packages/backend/built ./packages/backend/built
COPY --from=builder /misskey/packages/client/node_modules ./packages/client/node_modules
COPY . ./

CMD ["npm", "run", "migrateandstart"]
