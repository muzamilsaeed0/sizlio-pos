const path = require("path");
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const pool = require("./config/db");
const { authMiddleware } = require("./middleware/authMiddleware");

const app = express();

const pushRoutes = require("./routes/pushRoutes");

/* =====================================================
   TRUST PROXY
   Railway ke peechhe 'loopback' hi enough hai.
===================================================== */
app.set("trust proxy", "loopback");

/* =====================================================
   CORS — apne domains only
===================================================== */
const allowedOrigins = [
  "https://sizlio.com",
  "https://www.sizlio.com",
  process.env.NODE_ENV === "development" ? "http://localhost:3000" : null,
  process.env.NODE_ENV === "development" ? "http://localhost:5500" : null,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / server-to-server (no Origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);

/* =====================================================
   HELMET + CSP (proper directives, error fixed)
===================================================== */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.socket.io",
          "https://api.qrserver.com",
          "https://cdn.jsdelivr.net", 
        ],
         scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "wss:", "https:"],
        fontSrc: ["'self'", "data:"],
        frameSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

/* =====================================================
   BODY PARSERS
===================================================== */
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

/* =====================================================
   STATIC FILES
===================================================== */
console.log("Static folder path:", path.join(__dirname, "public"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "public", "images")));

/* =====================================================
   RATE LIMITERS
===================================================== */

// 1) Global limiter (sab API pe)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 300,             // 300 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", globalLimiter);

// 2) Strict login limiter
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: "Too many login attempts, try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Super Admin ko login rate-limit se exclude karo
app.use("/api/auth/login", (req, res, next) => {
  const username = String(req.body?.username || "").trim();

  if (username) {
    pool
      .query(
        `SELECT role
         FROM users
         WHERE username = $1
         LIMIT 1`,
        [username]
      )
      .then((result) => {
        const role = result.rows[0]?.role;

        if (role === "super_admin") {
          return next();
        }

        return loginLimiter(req, res, next);
      })
      .catch((err) => {
        console.error("Login rate-limit role check:", err);
        // DB fail ho to security ke liye normal limiter apply karo
        return loginLimiter(req, res, next);
      });

    return;
  }

  return loginLimiter(req, res, next);
});

/* =====================================================
   DATABASE CONNECT CHECK — fail fast
===================================================== */
pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("❌ Database Connection Failed:", err.message);
    process.exit(1); // Railway restart karega
  } else {
    console.log("✅ Database Connected Successfully");
    console.log("Server Time:", result.rows[0].now);
  }
});

/* =====================================================
   HTML PAGE ROUTES
===================================================== */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/customer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer.html"));
});

app.get("/counter", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "counter.html"));
});

app.get("/waiter", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "waiter.html"));
});

app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

app.get("/rider", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "rider.html"));
});

app.get("/status", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "status.html"));
});

app.get("/manager", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manager.html"));
});

app.get("/sales", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});

app.get("/inventory", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "inventory.html"));
});

app.get("/bill", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bill.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "superadmin.html"));
});

/* =====================================================
   API ROUTES
===================================================== */
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/menu", require("./routes/menuRoutes"));
app.use("/api/deals", require("./routes/dealRoutes"));
app.use("/api/menu-variants", require("./routes/menuVariantRoutes"));
app.use("/api/fbr", require("./routes/fbrRoutes"));
app.use("/api/suppliers", require("./routes/supplierRoutes"));
app.use("/api/categories", require("./routes/categoryRoutes"));
app.use("/api/orders", require("./routes/orderRoutes"));
app.use("/api/reports", require("./routes/reportRoutes"));
app.use("/api/public", require("./routes/publicRoutes"));
app.use("/api/inventory", require("./routes/inventoryRoutes"));
app.use("/api/kitchen-inventory", require("./routes/kitchenInventoryRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/restaurants", require("./routes/restaurantRoutes"));
app.use("/api/shifts", require("./routes/shiftRoutes"));
app.use("/api/push", pushRoutes);
app.use("/api/payments", require("./routes/paymentRoutes"));
app.use("/api/settings", require("./routes/settingsRoutes"));

/* =====================================================
   HTTP SERVER + SOCKET.IO
===================================================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

/* ---------- Socket auth ---------- */
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

/* ---------- Online users tracker ---------- */
const connectedUsers = new Map();

/* ---------- SINGLE connection handler ---------- */
io.on("connection", (socket) => {
  const roomName = `restaurant_${socket.user.restaurant_id}`;
  socket.join(roomName);

  connectedUsers.set(socket.user.id, {
    id: socket.user.id,
    role: socket.user.role,
    restaurant_id: socket.user.restaurant_id,
    connected_at: new Date(),
    socket_id: socket.id,
  });

  console.log(
    `✅ ONLINE: User ${socket.user.id} (${socket.user.role}) | Restaurant ${socket.user.restaurant_id} | Socket ${socket.id} | Total: ${connectedUsers.size}`
  );
  console.log("ROOM JOINED:", roomName);

  socket.on("disconnect", (reason) => {
    connectedUsers.delete(socket.user.id);
    console.log(
      `❌ OFFLINE: User ${socket.user.id} | ${reason} | Total: ${connectedUsers.size}`
    );
  });
});

/* Make io accessible in controllers */
app.set("io", io);

/* =====================================================
   PUBLIC URL
===================================================== */
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  `http://localhost:${process.env.PORT || 3000}`;
app.set("PUBLIC_URL", PUBLIC_URL);

/* =====================================================
   ADMIN ENDPOINT — auth + super_admin ONLY
===================================================== */
app.get("/api/admin/online-users", authMiddleware, (req, res) => {
  if (req.user.role !== "super_admin") {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  const online = Array.from(connectedUsers.values());
  res.json({
    success: true,
    count: online.length,
    users: online,
  });
});

/* =====================================================
   FBR RETRY WORKER
===================================================== */
try {
  const { startFbrRetryWorker } = require("./services/fbrRetryWorker");
  startFbrRetryWorker();
  console.log("✅ FBR retry worker started");
} catch (err) {
  console.warn("⚠️  FBR retry worker not started:", err.message);
}

/* =====================================================
   GLOBAL ERROR HANDLER (must be last)
===================================================== */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "Server error" });
});

/* =====================================================
   START SERVER
===================================================== */
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Public URL: ${PUBLIC_URL}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
});