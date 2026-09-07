import { FaceDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const stats = document.getElementById("stats");

async function main() {
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  let faceDetector;
  let delegate = "GPU";
  try {
    faceDetector = await FaceDetector.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
    });
  } catch (e) {
    console.warn("GPU delegate failed, falling back to CPU (WASM)", e);
    delegate = "CPU";
    faceDetector = await FaceDetector.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "CPU",
      },
      runningMode: "VIDEO",
    });
  }

  stats.textContent = `Model loaded (delegate: ${delegate}). Starting webcam...`;

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = resolve));

  stats.textContent = `Running (delegate: ${delegate})...`;

  let lastVideoTime = -1;
  function detectLoop() {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;

      const startTime = performance.now();
      const result = faceDetector.detectForVideo(video, startTime);
      const latencyMs = (performance.now() - startTime).toFixed(1);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#6EA8FE";
      ctx.lineWidth = 3;
      ctx.font = "16px monospace";
      ctx.fillStyle = "#6EA8FE";

      for (const detection of result.detections) {
        const box = detection.boundingBox;
        ctx.strokeRect(box.originX, box.originY, box.width, box.height);
        ctx.fillText(
          `face ${(detection.categories[0].score * 100).toFixed(0)}%`,
          box.originX,
          box.originY - 6
        );
      }

      stats.textContent = `Delegate: ${delegate} | Faces: ${result.detections.length} | Latency: ${latencyMs} ms`;
    }
    requestAnimationFrame(detectLoop);
  }

  detectLoop();
}

main().catch((err) => {
  console.error(err);
  stats.textContent = "ERROR: " + err.message;
});