FROM node:19 AS build

WORKDIR /app

ADD package.json package-lock.json patches /app/
RUN npm install

ADD . /app
RUN npx tsc

FROM node:19

WORKDIR /app

ADD package.json package-lock.json /app/
RUN npm install --only=production

ADD . /app
COPY --from=build /app/dist /app/dist

RUN ln -s /data /app/data

ENV NODE_ENV=production

VOLUME [ "/data" ]

CMD [ "node", "/app/dist/server-entry.js" ]
