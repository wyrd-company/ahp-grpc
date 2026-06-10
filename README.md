# AHP gRPC Transport

gRPC transport bindings for Agent Host Protocol (AHP).

Package target: `@wyrd-company/ahp-grpc`.

This package contains the TypeScript implementation first. The wire contract is
defined in `proto/wyrd/ahp/transport/v1/transport.proto` so future
implementations can target other languages.

## Wire Contract

The transport exposes one bidirectional streaming RPC:

```protobuf
service AhpTransport {
  rpc Connect(stream AhpFrame) returns (stream AhpFrame);
}

message AhpFrame {
  string text = 1;
}
```

Each `text` value is one UTF-8 JSON-RPC AHP frame.

The initial server listener targets Unix domain sockets. TypeScript clients use
`GrpcAhpClientTransport` with the Microsoft AHP TypeScript client.

## Development

```bash
npm install
npm run verify
```
