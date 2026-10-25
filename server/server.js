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

const wholesaleRoutes = require("./routes/wholesaleRoutes");

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
  "http://localhost:3000",
  "http://127.0.0.1:3000",
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
   HELMET + CSP
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
app.use(express.json({
  limit: "5mb",
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

/* =====================================================
   STATIC FILES
===================================================== */
console.log("Static folder path:", path.join(__dirname, "public"));


/* =====================================================
   RATE LIMITERS
===================================================== */

// 1) Global limiter (sab API pe)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
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

// Apply the same brute-force protection to every account, including Super Admin.
// Authentication must not reveal account role before password verification.
app.use("/api/auth/login", loginLimiter);

/* =====================================================
   DATABASE CONNECT CHECK — fail fast
===================================================== */
pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("❌ Database Connection Failed:", err.message);
    process.exit(1);
  } else {
    console.log("✅ Database Connected Successfully");
    console.log("Server Time:", result.rows[0].now);
  }
});

/* =====================================================
   HTML PAGE ROUTES
===================================================== */

// Enforce page access on the server, not only in navigation menus.
// Browser sessions use the HttpOnly sizlio_session cookie. API routes still
// enforce their own authorization; this page gate is an additional boundary.
function protectedPage(filename, policy = {}) {
  return (req, res) => {
    const sendPage = () =>
      res.sendFile(path.join(__dirname, 'public', filename));

    const clearSessionAndShowLogin = () => {
      res.clearCookie('sizlio_session', {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
      });
      return sendPage();
    };

    const hasSessionCookie = (req.headers.cookie || '')
      .split(';')
      .some(part => part.trim().startsWith('sizlio_session='));

    // No cookie → always show the page (login UI inside HTML)
    if (!hasSessionCookie) {
      return sendPage();
    }

    // Cookie present: authenticate, but NEVER return API JSON for HTML routes.
    // On expired/invalid session or wrong role → clear cookie + show login page.
    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let blocked = false;

    res.status = (code) => {
      if (code === 401 || code === 403) blocked = true;
      return originalStatus(code);
    };

    res.json = (body) => {
      if (blocked) {
        return clearSessionAndShowLogin();
      }
      return originalJson(body);
    };

    authMiddleware(req, res, async () => {
      // Restore normal res methods after successful auth
      res.status = originalStatus;
      res.json = originalJson;

      try {
        const role = req.user?.role;
        const roles = policy.roles || [];

        if (!roles.includes(role)) {
          // Wrong role for this screen → login page, not JSON / plain 403
          return clearSessionAndShowLogin();
        }

        let restaurant = null;
        if (role !== 'super_admin') {
          const restaurantId = Number(req.user?.restaurant_id);
          if (!Number.isSafeInteger(restaurantId) || restaurantId <= 0) {
            return clearSessionAndShowLogin();
          }
          const result = await pool.query(
            'SELECT plan, business_type FROM restaurants WHERE id = $1',
            [restaurantId]
          );
          if (!result.rows.length) {
            return clearSessionAndShowLogin();
          }
          restaurant = result.rows[0];
        }

        if (policy.requireCafeLite && restaurant?.plan !== 'Cafe Lite') {
          return res.status(403).send('This screen is only available on the Cafe Lite plan.');
        }
        if (policy.blockCafeLite && restaurant?.plan === 'Cafe Lite') {
          return res.status(403).send('This screen is not available on the Cafe Lite plan. Use Counter Lite or Rider.');
        }
        if (policy.businessType && restaurant?.business_type !== policy.businessType) {
          return res.status(403).send('This screen is not enabled for this business type.');
        }

        return sendPage();
      } catch (err) {
        console.error('Protected page access:', err.message);
        return clearSessionAndShowLogin();
      }
    });
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/customer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer.html"));
});

app.get("/counter", protectedPage("counter.html", { roles: ["counter"], blockCafeLite: true }));

app.get("/waiter", protectedPage("waiter.html", { roles: ["waiter"], blockCafeLite: true }));

app.get("/kitchen", protectedPage("kitchen.html", { roles: ["kitchen"], blockCafeLite: true }));

app.get("/rider", protectedPage("rider.html", { roles: ["rider", "delivery_rider", "delivery"] }));

app.get("/status", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "status.html"));
});

app.get("/manager", protectedPage("manager.html", { roles: ["manager"], blockCafeLite: true }));

app.get("/sales", protectedPage("sales.html", { roles: ["manager", "counter"], blockCafeLite: true }));

app.get("/inventory", protectedPage("inventory.html", { roles: ["manager", "counter"], blockCafeLite: true }));

app.get("/bill", protectedPage("bill.html", { roles: ["manager", "counter", "waiter"], blockCafeLite: true }));

app.get("/admin", protectedPage("superadmin.html", { roles: ["super_admin"] }));

app.get("/counter-lite", protectedPage("counter-lite.html", { roles: ["counter"], requireCafeLite: true }));

app.get("/wholesale", protectedPage("wholesale.html", { roles: ["manager", "counter"], businessType: "wholesale" }));
app.get("/wholesale.html", protectedPage("wholesale.html", { roles: ["manager", "counter"], businessType: "wholesale" }));
// Apply the same policy to direct .html URLs; otherwise express.static could
// serve these files without passing through the extensionless page handlers.
app.get("/counter.html", protectedPage("counter.html", { roles: ["counter"], blockCafeLite: true }));
app.get("/waiter.html", protectedPage("waiter.html", { roles: ["waiter"], blockCafeLite: true }));
app.get("/kitchen.html", protectedPage("kitchen.html", { roles: ["kitchen"], blockCafeLite: true }));
app.get("/rider.html", protectedPage("rider.html", { roles: ["rider", "delivery_rider", "delivery"] }));
app.get("/manager.html", protectedPage("manager.html", { roles: ["manager"], blockCafeLite: true }));
app.get("/sales.html", protectedPage("sales.html", { roles: ["manager", "counter"], blockCafeLite: true }));
app.get("/inventory.html", protectedPage("inventory.html", { roles: ["manager", "counter"], blockCafeLite: true }));
app.get("/bill.html", protectedPage("bill.html", { roles: ["manager", "counter", "waiter"], blockCafeLite: true }));
app.get("/superadmin.html", protectedPage("superadmin.html", { roles: ["super_admin"] }));
app.get("/counter-lite.html", protectedPage("counter-lite.html", { roles: ["counter"], requireCafeLite: true }));


// Static assets are mounted after the explicit protected-page aliases.
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "public", "images")));

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
app.use("/api/wholesale", wholesaleRoutes);
app.use("/api/refunds", require("./routes/refundRoutes"));
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

/* ---------- Socket user validation ---------- */
/*
 * JWT is only the identity proof. Before accepting a socket,
 * re-check the database so disabled users, suspended/expired
 * restaurants, and old sessions cannot use a stale token.
 */
const getSocketUser = async (decoded) => {
  if (!decoded?.id || !decoded?.sessionId) {
    throw new Error("Invalid session");
  }

  const result = await pool.query(
    `
      SELECT
        u.id,
        u.role,
        u.restaurant_id,
        u.is_active,
        u.current_session,
        r.status,
        r.expiry_date
      FROM users u
      LEFT JOIN restaurants r
        ON r.id = u.restaurant_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [decoded.id]
  );

  if (!result.rowCount) {
    throw new Error("User not found");
  }

  const user = result.rows[0];

  if (!user.is_active) {
    throw new Error("User account disabled");
  }

  if (user.current_session !== decoded.sessionId) {
    throw new Error("Session expired");
  }

  if (user.role !== "super_admin" && user.status !== "Active") {
    throw new Error("Restaurant suspended");
  }

  if (
    user.role !== "super_admin" &&
    user.expiry_date &&
    new Date(user.expiry_date) < new Date()
  ) {
    throw new Error("Restaurant subscription expired");
  }

  return {
    id: user.id,
    role: user.role,
    restaurant_id: user.restaurant_id,
  };
};

/* ---------- Socket auth ---------- */
io.use(async (socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie || '';
    const cookieToken = cookieHeader
      .split(';')
      .map(part => part.trim())
      .filter(part => part.startsWith('sizlio_session='))
      .map(part => decodeURIComponent(part.slice('sizlio_session='.length)))[0] || null;
    const token = cookieToken || socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await getSocketUser(decoded);

    // Never trust role/restaurant_id from a stale JWT payload.
    socket.user = user;
    next();
  } catch (err) {
    console.error("Socket auth rejected:", err.message);
    next(new Error("Invalid or expired session"));
  }
});

/*
 * Revalidate the DB session before every client -> server event.
 * This makes logout-from-another-device, account disable,
 * restaurant suspension, and subscription expiry effective
 * without waiting for the socket to reconnect.
 */
io.use((socket, next) => {
  socket.use(async (packet, packetNext) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie || '';
      const cookieToken = cookieHeader
        .split(';')
        .map(part => part.trim())
        .filter(part => part.startsWith('sizlio_session='))
        .map(part => decodeURIComponent(part.slice('sizlio_session='.length)))[0] || null;
      const token = cookieToken || socket.handshake.auth?.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await getSocketUser(decoded);

      socket.user = user;
      packetNext();
    } catch (err) {
      console.error("Socket session rejected:", err.message);
      socket.disconnect(true);
      packetNext(new Error("Session expired. Please login again."));
    }
  });

  next();
});

/* ---------- Online users tracker ---------- */
/*
 * One user can have multiple tabs/devices. Track every socket
 * independently so disconnecting one socket does not mark the
 * whole user offline.
 *
 * Map<userId, Map<socketId, metadata>>
 */
const connectedUsers = new Map();

const addConnectedSocket = (socket) => {
  const userId = socket.user.id;

  if (!connectedUsers.has(userId)) {
    connectedUsers.set(userId, new Map());
  }

  connectedUsers.get(userId).set(socket.id, {
    id: socket.user.id,
    role: socket.user.role,
    restaurant_id: socket.user.restaurant_id,
    connected_at: new Date(),
    socket_id: socket.id,
  });
};

const removeConnectedSocket = (socket) => {
  const userId = socket.user?.id;
  if (!userId) return;

  const userSockets = connectedUsers.get(userId);
  if (!userSockets) return;

  userSockets.delete(socket.id);

  if (userSockets.size === 0) {
    connectedUsers.delete(userId);
  }
};

/* ---------- SINGLE connection handler ---------- */
io.on("connection", (socket) => {
  const restaurantId = socket.user.restaurant_id;
  const roomName = restaurantId ? `restaurant_${restaurantId}` : null;

  if (roomName) {
    socket.join(roomName);
    console.log("ROOM JOINED:", roomName);
  }

  addConnectedSocket(socket);

  console.log(
    `✅ ONLINE: User ${socket.user.id} (${socket.user.role}) | Restaurant ${socket.user.restaurant_id} | Socket ${socket.id} | Users: ${connectedUsers.size}`
  );

  socket.on("disconnect", (reason) => {
    removeConnectedSocket(socket);

    console.log(
      `❌ OFFLINE SOCKET: User ${socket.user.id} | Socket ${socket.id} | ${reason} | Users: ${connectedUsers.size}`
    );
  });
});

/* Make io accessible in controllers */
app.set("io", io);

/* =====================================================
   HEALTH CHECKS
   Liveness is process-only; readiness verifies the database.
   Keep responses minimal and never expose connection details.
===================================================== */
app.get("/health/live", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

app.get("/health/ready", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ status: "ready" });
  } catch (err) {
    console.error("Readiness check failed:", err.message);
    return res.status(503).json({ status: "not_ready" });
  }
});

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

  // Return one record per online user, even if they have
  // multiple tabs/devices connected.
  const online = Array.from(connectedUsers.entries()).map(
    ([userId, sockets]) => {
      const first = sockets.values().next().value;

      return {
        id: Number(userId),
        role: first.role,
        restaurant_id: first.restaurant_id,
        connected_at: first.connected_at,
        socket_count: sockets.size,
      };
    }
  );

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
   GLOBAL ERROR HANDLER
===================================================== */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Normalize upload/parser errors so clients receive safe JSON instead
  // of a generic 500 when a logo is too large or has an unsupported type.
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      code: "UPLOAD_FILE_TOO_LARGE",
      message: "Logo file must be 2 MB or smaller"
    });
  }

  if (
    err?.code === "LIMIT_FILE_COUNT" ||
    err?.code === "LIMIT_UNEXPECTED_FILE" ||
    err?.code === "INVALID_LOGO_TYPE"
  ) {
    return res.status(400).json({
      success: false,
      code: "INVALID_UPLOAD",
      message: err.code === "INVALID_LOGO_TYPE"
        ? "Only JPG, PNG, and WebP images are allowed"
        : "Invalid upload. Please upload one logo image."
    });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({
    success: false,
    message: "Server error"
  });
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
