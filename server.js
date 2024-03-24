const express = require("express");
const client = require("prom-client");
const diskUsage = require("diskusage");
const Pusher = require("pusher");
const path = require("path");
require("dotenv").config();

const app = express();
const port = process.env.PORT;

const logFilePath = path.join(__dirname, `.pm2/logs/server-${cid}.log`);

function sendLogEntry(logEntry) {
  const now = new Date();
  const datetimeTag = `${now.toISOString()} | `;
  const channel = `dashify-` + process.env.cid; // replace dashify-1 with env of dashify-{cid}
  pusher.trigger(channel, "logs", {
    message: datetimeTag + logEntry,
  });
}

function watchLogFile() {
  if (fs.existsSync(logFilePath)) {
    let fileSize = fs.statSync(logFilePath).size;

    fs.watchFile(logFilePath, (current) => {
      if (current.size > fileSize) {
        const stream = fs.createReadStream(logFilePath, {
          start: fileSize,
          end: current.size,
        });

        stream.on("data", (data) => {
          sendLogEntry(data.toString());
        });

        fileSize = current.size;
      }
    });
  } else {
    setTimeout(watchLogFile, 10000); // Check again after a delay
  }
}

const pusher = new Pusher({
  appId: process.env.appId,
  key: process.env.key,
  secret: process.env.secret,
  cluster: process.env.cluster,
  useTLS: process.env.useTLS,
});



// Create a Registry to register the metrics
const register = new client.Registry();

// Add a default label which is added to all metrics
client.collectDefaultMetrics({ register });

function spikeMemoryUsage() {
  const maxMemory = process.memoryUsage().heapTotal;
  let usedMemory = process.memoryUsage().heapUsed;
  let dummyArray = [];

  while (usedMemory / maxMemory < 0.8) {
    const blockSize = 1024 * 1024; // Allocate memory in blocks of 1 MB (adjust as needed)

    while (usedMemory + blockSize < maxMemory * 0.8) {
      dummyArray.push(Buffer.alloc(blockSize, "x")); // Allocate 1 MB of memory
      usedMemory += blockSize;
    }
    dummyArray = null;
  }

  console.log("Memory spiked to approximately 80%.");
}

function updateHeapMetrics() {
  const memoryUsage = process.memoryUsage();
  heapUsedGauge.set(memoryUsage.heapUsed);
  heapTotalGauge.set(memoryUsage.heapTotal);
}

// Function to update disk usage metric
async function updateDiskUsageMetric() {
  try {
    diskUsage.check("/", (err, info) => {
      if (err) {
        console.error("Error getting disk info:", err);
        return;
      }
      const used = info.total - info.available;
      const usagePercentage = (used / info.total) * 100;
      diskUsageGauge.set(usagePercentage);
    });
  } catch (error) {
    console.error("Error getting disk info:", error);
  }
}

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route"],
  registers: [register],
});

const systemUptime = new client.Gauge({
  name: "system_uptime_seconds",
  help: "System uptime in seconds",
  collect() {
    // Set the gauge to the system uptime whenever Prometheus scrapes the /metrics endpoint
    this.set(process.uptime());
  },
});

const incomingTraffic = new client.Counter({
  name: "incoming_traffic_bytes",
  help: "Total incoming traffic in bytes",
});

const outgoingTraffic = new client.Counter({
  name: "outgoing_traffic_bytes",
  help: "Total outgoing traffic in bytes",
});

const diskUsageGauge = new client.Gauge({
  name: "disk_usage_bytes",
  help: "Disk usage in bytes",
  labelNames: ["filesystem"],
});

const heapUsedGauge = new client.Gauge({
  name: "nodejs_process_heap_used_bytes",
  help: "Amount of heap used by the Node.js process in bytes.",
});

const heapTotalGauge = new client.Gauge({
  name: "nodejs_process_heap_total_bytes",
  help: "Total size of the heap in bytes.",
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(systemUptime);
register.registerMetric(incomingTraffic);
register.registerMetric(outgoingTraffic);
register.registerMetric(diskUsageGauge);
register.registerMetric(heapUsedGauge);
register.registerMetric(heapTotalGauge);

// Update disk usage metric every minute
setInterval(updateDiskUsageMetric, 60000);

// Update metrics every 60 seconds
setInterval(updateHeapMetrics, 60000);

app.use((req, res, next) => {
  if (req.path !== "/metrics") {
    httpRequestsTotal.inc({ method: req.method, route: req.path });
  }

  // Measure incoming traffic
  const incomingBytes = Number(req.headers["content-length"]) || 0;
  incomingTraffic.inc(incomingBytes);

  // Intercept the response to measure outgoing traffic
  const originalSend = res.send;
  res.send = function (body) {
    const outgoingBytes = Buffer.byteLength(body || "");
    outgoingTraffic.inc(outgoingBytes);
    originalSend.call(this, body);
  };

  next();
});

// Define a route
app.get("/", (req, res) => {
  // Respond with hello world
  res.send("Hello World!");
});

// Define a route to expose the metrics
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// High CPU Usage Route
app.get("/high-cpu", async (req, res) => {
  sendLogEntry("Simulating work on high-cpu...");
  let result = 0;
  for (let i = 0; i < 1e4; i++) {
    for (let j = 0; j < 1e4; j++) {
      result += Math.sin(Math.cos(Math.sqrt(i * j)));
    }
  }

  res.send(`Result is ${result}`);
});

// High Memory Usage Route
app.get("/high-memory", (req, res) => {
  sendLogEntry("Simulating work on high-memory...");
  spikeMemoryUsage();
  res.send("Memory spiked to approximately 80%");
});

// Error Simulation Route
app.get("/error", (req, res) => {
  if (Math.random() > 0.5) {
    const logMessage = "Simulated error";
    sendLogEntry(logMessage);
    throw new Error(logMessage);
  }
  res.send("Hello World!");
});

// System Failure Simulation Route
app.get("/system-failure", (req, res) => {
  sendLogEntry("Simulating system failure...");
  process.exit(1);
});

// Downtime Simulation Route
let server;
app.get("/downtime", (req, res) => {
  if (server) {
    server.close(() => {
      const logMessage = "Server is going down...";
      sendLogEntry(logMessage);
      console.log("Server is temporarily down");
      setTimeout(() => {
        server = app.listen(port, () => {
          sendLogEntry(`Server is back up on port ${port}`);
          console.log(`Server is back up on port ${port}`);
        });
      }, 180000); // Down for 180 seconds
    });
  }
  res.send("Server going down for maintenance");
});

function sendPing() {
  const now = new Date();
  const message = `Server is still listening at http://localhost:${port}`;
  sendLogEntry(message);
}

// Schedule the ping function to run every 1 minute
setInterval(sendPing, 60000);

watchLogFile();

// Start the Server
server = app.listen(process.env.PORT, () => {
  console.log(`Server is listening on port ${process.env.PORT}`);
  sendLogEntry(`Server is listening on port ${process.env.PORT}`);
});
