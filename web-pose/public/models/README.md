This Next.js browser app uses the TensorFlow.js MoveNet model format. It cannot load
a `.tflite` file directly. Place the TensorFlow.js model bundle here as:

```
public/models/movenet-lightning/model.json
public/models/movenet-lightning/group1-shard*.bin
```

The application intentionally references `/models/movenet-lightning/model.json` rather
than a hosted TensorFlow URL. Bundle these files into the Android/iOS app package (or
precache them in the PWA) before enabling offline guidance.
