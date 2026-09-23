const path = require("path");
const jwt = require('jsonwebtoken');
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");

const pool = require("./config/db");

const app = express();

const pushRoutes = require('./routes/pushRoutes');

app.use(cors());
app.use(express.json());

console.log("Static folder path:", path.join(__dirname, "public"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "public", "images")));

// =====================================================
// HTML PAGE ROUTES
// =====================================================

// Landing page (Sizlio)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Customer QR ordering
app.get("/customer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer.html"));
});

// Counter POS
app.get("/counter", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "counter.html"));
});

// Waiter App
app.get("/waiter", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "waiter.html"));
});

// Kitchen Display
app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

// Rider App
app.get("/rider", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "rider.html"));
});

// Status Board
app.get("/status", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "status.html"));
});

// Manager Panel
app.get("/manager", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manager.html"));
});

// Sales Dashboard
app.get("/sales", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});

// Inventory
app.get("/inventory", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "inventory.html"));
});

// Bill / Receipt
app.get("/bill", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bill.html"));
});

// Super Admin Panel
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "superadmin.html"));
});

// Database Connection Test
pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("Database Connection Failed:", err.message);
  } else {
    console.log("Database Connected Successfully");
    console.log("Server Time:", result.rows[0].now);
  }
});

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

app.set('trust proxy', 1);
// ✅ CSP (Chrome wala error) fix karne ke liye yeh use karein:
app.use(helmet({ contentSecurityPolicy: false }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: 'Too many login attempts, try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Super Admin ko login rate-limit se exclude karo
app.use('/api/auth/login', (req, res, next) => {

  const username = String(req.body?.username || '').trim();

  if (username) {

    pool.query(
      `SELECT role
       FROM users
       WHERE username = $1
       LIMIT 1`,
      [username]
    )
    .then(result => {

      const role = result.rows[0]?.role;

      if (role === 'super_admin') {
        return next();
      }

      return loginLimiter(req, res, next);

    })
    .catch(err => {

      console.error('Login rate-limit role check:', err);

      // Agar DB check fail ho to security ke liye
      // normal limiter apply karo.
      return loginLimiter(req, res, next);

    });

    return;
  }

  return loginLimiter(req, res, next);
});

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/menu', require('./routes/menuRoutes'));
app.use('/api/deals', require('./routes/dealRoutes'));
app.use('/api/menu-variants', require('./routes/menuVariantRoutes'));
app.use('/api/fbr', require('./routes/fbrRoutes'));
app.use('/api/suppliers', require('./routes/supplierRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/public', require('./routes/publicRoutes'));
app.use('/api/inventory', require('./routes/inventoryRoutes'));
app.use('/api/kitchen-inventory', require('./routes/kitchenInventoryRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/restaurants', require('./routes/restaurantRoutes'));
app.use('/api/shifts', require('./routes/shiftRoutes'));
app.use('/api/push', pushRoutes);
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));


const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// Socket Authentication
io.use((socket, next) => {

  try {

    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    socket.user = decoded;

    next();

  } catch (err) {

    next(new Error("Invalid token"));

  }

});

// Socket Connection
io.on("connection", (socket) => {

  const roomName =
    `restaurant_${socket.user.restaurant_id}`;

  socket.join(roomName);

  console.log(
    `${socket.user.role} connected | Restaurant ${socket.user.restaurant_id} | Socket ${socket.id}`
  );

  console.log("ROOM JOINED:", roomName);

  socket.on("disconnect", (reason) => {

    console.log(
      `${socket.user.role} disconnected | ${socket.id} | ${reason}`
    );

  });

});

app.set("io", io);

// Public URL (.env se)
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  `http://localhost:${process.env.PORT || 3000}`;

app.set("PUBLIC_URL", PUBLIC_URL);

const PORT = process.env.PORT || 3000;

const { startFbrRetryWorker } = require('./services/fbrRetryWorker');
 startFbrRetryWorker();

server.listen(PORT, "0.0.0.0", () => {

  console.log(`Server running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);

});


// =====================================================
// CONNECTED USERS TRACKER
// =====================================================

const connectedUsers = new Map();

io.on("connection", (socket) => {

  const roomName = `restaurant_${socket.user.restaurant_id}`;
  socket.join(roomName);

  // ✅ User ko online mark karein
  connectedUsers.set(socket.user.id, {
    id: socket.user.id,
    role: socket.user.role,
    restaurant_id: socket.user.restaurant_id,
    connected_at: new Date(),
    socket_id: socket.id
  });

  console.log(`✅ ONLINE: User ${socket.user.id} (${socket.user.role})`);

  socket.on("disconnect", (reason) => {
    // ✅ User ko offline mark karein
    connectedUsers.delete(socket.user.id);
    console.log(`❌ OFFLINE: User ${socket.user.id} | ${reason}`);
  });

});

// ✅ API endpoint — kon online hai
app.get("/api/admin/online-users", (req, res) => {
  const online = Array.from(connectedUsers.values());
  res.json({
    success: true,
    count: online.length,
    users: online
  });
});