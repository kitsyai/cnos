package varrpc

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/encoding"
)

// Fully-qualified names from `packages/var-rpc/proto/cnos/var/v1/var.proto` — the canonical
// proto shared with the TypeScript side.
const (
	ServiceName     = "cnos.var.v1.VarService"
	PullMethod      = "/cnos.var.v1.VarService/Pull"
	SubscribeMethod = "/cnos.var.v1.VarService/Subscribe"
)

// codec adapts the hand-written wire marshalers to gRPC. It reports the standard name
// "proto" so the content-subtype stays `application/grpc+proto` and the bytes on the wire
// are ordinary protobuf — a peer built from generated code (including the TypeScript server)
// interoperates with it unchanged. It is applied per-call via grpc.ForceCodec /
// grpc.ForceServerCodec and is never registered globally, so it cannot disturb any other
// gRPC client in the same process.
type codec struct{}

// Codec returns the wire codec for the `cnos.var.v1` messages.
func Codec() encoding.Codec { return codec{} }

func (codec) Name() string { return "proto" }

func (codec) Marshal(value any) ([]byte, error) {
	switch message := value.(type) {
	case *PullRequest:
		return message.Marshal(), nil
	case *SubscribeRequest:
		return message.Marshal(), nil
	case *SnapshotBatch:
		return message.Marshal(), nil
	default:
		return nil, fmt.Errorf("varrpc: cannot marshal %T", value)
	}
}

func (codec) Unmarshal(data []byte, value any) error {
	switch message := value.(type) {
	case *PullRequest:
		return message.Unmarshal(data)
	case *SubscribeRequest:
		return message.Unmarshal(data)
	case *SnapshotBatch:
		return message.Unmarshal(data)
	default:
		return fmt.Errorf("varrpc: cannot unmarshal into %T", value)
	}
}

// VarServiceServer is the server-side contract of `cnos.var.v1.VarService`.
type VarServiceServer interface {
	Pull(context.Context, *PullRequest) (*SnapshotBatch, error)
	Subscribe(*SubscribeRequest, VarServiceSubscribeServer) error
}

// VarServiceSubscribeServer is the server side of the Subscribe server-stream.
type VarServiceSubscribeServer interface {
	Send(*SnapshotBatch) error
	grpc.ServerStream
}

type subscribeServerStream struct {
	grpc.ServerStream
}

func (stream *subscribeServerStream) Send(batch *SnapshotBatch) error {
	return stream.ServerStream.SendMsg(batch)
}

func pullHandler(service any, ctx context.Context, decode func(any) error, interceptor grpc.UnaryServerInterceptor) (any, error) {
	request := new(PullRequest)
	if err := decode(request); err != nil {
		return nil, err
	}
	if interceptor == nil {
		return service.(VarServiceServer).Pull(ctx, request)
	}
	return interceptor(ctx, request, &grpc.UnaryServerInfo{Server: service, FullMethod: PullMethod},
		func(ctx context.Context, request any) (any, error) {
			return service.(VarServiceServer).Pull(ctx, request.(*PullRequest))
		})
}

func subscribeHandler(service any, stream grpc.ServerStream) error {
	request := new(SubscribeRequest)
	if err := stream.RecvMsg(request); err != nil {
		return err
	}
	return service.(VarServiceServer).Subscribe(request, &subscribeServerStream{ServerStream: stream})
}

// ServiceDesc describes `cnos.var.v1.VarService` for grpc-go registration.
var ServiceDesc = grpc.ServiceDesc{
	ServiceName: ServiceName,
	HandlerType: (*VarServiceServer)(nil),
	Methods: []grpc.MethodDesc{
		{MethodName: "Pull", Handler: pullHandler},
	},
	Streams: []grpc.StreamDesc{
		{StreamName: "Subscribe", Handler: subscribeHandler, ServerStreams: true},
	},
	Metadata: "cnos/var/v1/var.proto",
}

// RegisterVarServiceServer registers an implementation on a gRPC server. The server MUST be
// constructed with grpc.ForceServerCodec(varrpc.Codec()).
func RegisterVarServiceServer(registrar grpc.ServiceRegistrar, service VarServiceServer) {
	registrar.RegisterService(&ServiceDesc, service)
}

// --- client ---

// VarServiceSubscribeClient is the client side of the Subscribe server-stream.
type VarServiceSubscribeClient interface {
	Recv() (*SnapshotBatch, error)
	grpc.ClientStream
}

type subscribeClientStream struct {
	grpc.ClientStream
}

func (stream *subscribeClientStream) Recv() (*SnapshotBatch, error) {
	batch := new(SnapshotBatch)
	if err := stream.ClientStream.RecvMsg(batch); err != nil {
		return nil, err
	}
	return batch, nil
}

type varServiceClient struct {
	conn grpc.ClientConnInterface
}

func newVarServiceClient(conn grpc.ClientConnInterface) *varServiceClient {
	return &varServiceClient{conn: conn}
}

func (client *varServiceClient) Pull(ctx context.Context, request *PullRequest, opts ...grpc.CallOption) (*SnapshotBatch, error) {
	response := new(SnapshotBatch)
	options := append([]grpc.CallOption{grpc.ForceCodec(Codec())}, opts...)
	if err := client.conn.Invoke(ctx, PullMethod, request, response, options...); err != nil {
		return nil, err
	}
	return response, nil
}

func (client *varServiceClient) Subscribe(ctx context.Context, request *SubscribeRequest, opts ...grpc.CallOption) (VarServiceSubscribeClient, error) {
	options := append([]grpc.CallOption{grpc.ForceCodec(Codec())}, opts...)
	stream, err := client.conn.NewStream(ctx, &ServiceDesc.Streams[0], SubscribeMethod, options...)
	if err != nil {
		return nil, err
	}
	if err := stream.SendMsg(request); err != nil {
		return nil, err
	}
	if err := stream.CloseSend(); err != nil {
		return nil, err
	}
	return &subscribeClientStream{ClientStream: stream}, nil
}
