// IR の計算をメインスレッドから外す
import { renderRoom } from './model.js';

self.onmessage = (e) => {
  const { id, spec, sampleRate } = e.data;
  const result = renderRoom(spec, sampleRate);
  self.postMessage({ id, result }, [result.ir[0].buffer, result.ir[1].buffer]);
};
