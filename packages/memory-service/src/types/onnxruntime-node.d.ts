// Created by dev on 2026/04/05
// onnxruntime-node 类型声明（内联定义，不依赖 onnxruntime-common）

declare module 'onnxruntime-node' {
  export type GraphOptimizationLevel = 'disabled' | 'basic' | 'extended' | 'all';

  export namespace InferenceSession {
    interface SessionOptions {
      executionProviders?: string[];
      graphOptimizationLevel?: GraphOptimizationLevel;
      intraOpNumThreads?: number;
      interOpNumThreads?: number;
      logSeverityLevel?: number;
    }

    function create(path: string, options?: SessionOptions): Promise<InferenceSession>;
  }

  export interface InferenceSession {
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    dispose(): void;
    readonly inputNames: string[];
    readonly outputNames: string[];
  }

  export type TensorType = 'float32' | 'float64' | 'int32' | 'int64' | 'uint8' | 'bool' | 'string';

  export class Tensor {
    constructor(type: TensorType, data: ArrayLike<number> | BigInt64Array | BigUint64Array, dims?: number[]);
    readonly data: Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array;
    readonly dims: number[];
    readonly type: TensorType;
    readonly size: number;
  }

  export function listSupportedBackends(): Array<{ name: string }>;
}
