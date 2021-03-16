FROM node:14.15.4-alpine AS base

ENV NODE_ENV=production

WORKDIR /misskey

FROM base AS builder

RUN apk add --no-cache \
    autoconf \
    automake \
    file \
		git \
    g++ \
    gcc \
    libc-dev \
    libtool \
    make \
    nasm \
    pkgconfig \
    python \
    zlib-dev
# sharp 0.28.0 でarm64v8のprebuiltバイナリが出るので下記は不要になるかもしれない
# https://github.com/lovell/sharp/issues/2498
RUN apk add libimagequant-dev --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main
RUN apk add vips-dev --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community

COPY package.json yarn.lock ./
RUN yarn install
COPY . ./
RUN yarn build

FROM base AS runner

RUN apk add --no-cache \
    ffmpeg \
    tini
RUN npm i -g web-push
ENTRYPOINT ["/sbin/tini", "--"]

COPY --from=builder /misskey/node_modules ./node_modules
COPY --from=builder /misskey/built ./built
COPY . ./

CMD ["npm", "run", "migrateandstart"]
