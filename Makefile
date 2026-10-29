.PHONY: all build test typecheck clean

all: build

build:
	npm run build

test:
	npm test

typecheck:
	npm run typecheck

clean:
	rm -rf dist coverage
