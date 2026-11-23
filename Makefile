BIN     := tabletmode
UUID    := tabletmode@local
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
DIST    := dist/$(BIN)-$(VERSION)

.PHONY: all build test vet install uninstall dist clean

all: build

build:
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o $(BIN) .

test:
	go test ./...

vet:
	go vet ./...

install: build
	./install.sh

uninstall:
	./uninstall.sh

# Release tarball with a prebuilt binary, so users do not need Go installed.
dist: build
	rm -rf $(DIST)
	mkdir -p $(DIST)/extension
	cp $(BIN) install.sh uninstall.sh tabletmode.service README.md LICENSE $(DIST)/
	cp extension/extension.js extension/metadata.json $(DIST)/extension/
	tar -C dist -czf $(DIST).tar.gz $(notdir $(DIST))
	@echo "Created $(DIST).tar.gz"

clean:
	rm -rf $(BIN) dist
