default:
    @just --list

install:
    npm ci

build:
    npm run build

check:
    npm run check

test:
    npm test

browser:
    npm run test:browser

primitives:
    npm run test:cross-language

format:
    npm run format

pack-check:
    npm run pack:check

run:
    npm run start -w @haip/server

docs:
    cd docs && mint dev
