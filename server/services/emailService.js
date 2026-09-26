const { Resend } = require("resend");

// =====================================================
// RESEND CLIENT
// =====================================================

const resend = new Resend(process.env.RESEND_API_KEY);

// =====================================================
// FROM ADDRESSES (with fallbacks)
// =====================================================

const FROM_NO_REPLY =
  process.env.EMAIL_FROM_NO_REPLY ||
  "Sizlio POS <no-reply@sizlio.com>";

const FROM_SALES =
  process.env.EMAIL_FROM_SALES ||
  "Sizlio Sales <sales@sizlio.com>";

// ✅ Support — agar set nahi hai to no-reply use kare
const FROM_SUPPORT =
  process.env.EMAIL_FROM_SUPPORT ||
  FROM_NO_REPLY;

const FROM_DEFAULT =
  process.env.EMAIL_FROM ||
  FROM_NO_REPLY;

// =====================================================
// GET BASE URL
// =====================================================

function getBaseUrl() {
  const url =
    process.env.PUBLIC_URL ||
    process.env.APP_URL ||
    `http://localhost:${process.env.PORT || 3000}`;
  return url.replace(/\/+$/, "");
}

// =====================================================
// ROLE LOGIN URL
// =====================================================

function getLoginUrl(role, restaurantId) {
  const baseUrl = getBaseUrl();

  const pages = {
    manager: "manager.html",
    waiter: "waiter.html",
    kitchen: "kitchen.html",
    counter: "counter.html",
    display: "display.html",
    delivery: "rider.html",
    rider: "rider.html",
    delivery_rider: "rider.html"
  };

  const page = pages[role];
  if (!page) {
    throw new Error(`Unknown login role: ${role}`);
  }

  const url = `${baseUrl}/${page}`;
  if (restaurantId) {
    return `${url}?restaurant=${restaurantId}`;
  }

  return url;
}

// =====================================================
// SEND RESTAURANT CREDENTIALS
// =====================================================

const sendRestaurantCredentials = async ({
  restaurant,
  manager,
  staff
}) => {

  /* =====================================================
     MANAGER — OPTIONAL (Cafe Lite ke liye ho sakta hai null)
  ===================================================== */

  const hasManager =
    manager &&
    manager.username &&
    manager.password;

  let managerLoginUrl = null;

  if (hasManager) {
    managerLoginUrl = getLoginUrl("manager", restaurant.id);
  }

  /* =====================================================
     ROLE NAMES
  ===================================================== */

  const roleNames = {
    waiter: "Waiter",
    kitchen: "Kitchen",
    counter: "Counter",
    display: "Display",
    rider: "Delivery",
    delivery: "Delivery",
    delivery_rider: "Delivery"
  };

  /* =====================================================
     STAFF SECTIONS
  ===================================================== */

  const staffSections = [];

  for (const role of Object.keys(staff || {})) {

    const accounts = staff[role];

    if (!Array.isArray(accounts) || !accounts.length) {
      continue;
    }

    const loginRole =
      (role === "rider" || role === "delivery_rider")
        ? "delivery"
        : role;

    const roleTitle =
      roleNames[role] ||
      (role.charAt(0).toUpperCase() + role.slice(1));

    const loginUrl = getLoginUrl(loginRole, restaurant.id);

    staffSections.push(`
      <div style="margin-top:30px;padding:22px;border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;">
        <h3 style="margin:0 0 10px 0;color:#111827;">${escapeHtml(roleTitle)} Accounts</h3>

        <div style="background:#f3f4f6;padding:12px 14px;border-radius:8px;margin-bottom:15px;">
          <strong>${escapeHtml(roleTitle)} Login URL</strong><br>
          <a href="${escapeAttribute(loginUrl)}" style="color:#2563eb;text-decoration:none;word-break:break-all;">
            ${escapeHtml(loginUrl)}
          </a>
          <br><br>
          <a href="${escapeAttribute(loginUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:9px 16px;border-radius:7px;text-decoration:none;font-weight:bold;">
            Open ${escapeHtml(roleTitle)} Login
          </a>
        </div>

        <table cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;">
          <tr style="background:#f9fafb;">
            <th align="left" style="border-bottom:1px solid #e5e7eb;">Username</th>
            <th align="left" style="border-bottom:1px solid #e5e7eb;">Password</th>
          </tr>
          ${accounts.map(account => `
            <tr>
              <td style="border-bottom:1px solid #e5e7eb;">${escapeHtml(account.username)}</td>
              <td style="border-bottom:1px solid #e5e7eb;font-weight:bold;">${escapeHtml(account.password)}</td>
            </tr>
          `).join("")}
        </table>
      </div>
    `);
  }

  /* =====================================================
     MANAGER SECTION — OPTIONAL
  ===================================================== */

  const managerSection = hasManager
    ? `
      <div style="margin-top:30px;padding:22px;border:1px solid #e5e7eb;border-radius:12px;">
        <h3 style="margin-top:0;">Manager Account</h3>

        <div style="background:#f3f4f6;padding:12px;border-radius:8px;margin-bottom:15px;">
          <strong>Manager Login URL</strong><br>
          <a href="${escapeAttribute(managerLoginUrl)}" style="color:#2563eb;word-break:break-all;">
            ${escapeHtml(managerLoginUrl)}
          </a>
          <br><br>
          <a href="${escapeAttribute(managerLoginUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:9px 16px;border-radius:7px;text-decoration:none;font-weight:bold;">
            Open Manager Login
          </a>
        </div>

        <table cellpadding="10" style="width:100%;border-collapse:collapse;">
          <tr>
            <td>Username</td>
            <td><strong>${escapeHtml(manager.username)}</strong></td>
          </tr>
          <tr>
            <td>Password</td>
            <td><strong>${escapeHtml(manager.password || "-")}</strong></td>
          </tr>
        </table>
      </div>
    `
    : `
      <div style="margin-top:30px;padding:18px;background:#fef3c7;border:1px solid #fde68a;border-radius:10px;">
        <strong>ℹ️ Cafe Lite — No Manager Account</strong>
        <p style="margin-bottom:0;line-height:1.5;">
          This restaurant was created without a Manager account.
          You can add a manager later from the Super Admin panel if needed.
        </p>
      </div>
    `;

  /* =====================================================
     FULL EMAIL HTML
  ===================================================== */

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
      <div style="max-width:720px;margin:30px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

        <div style="background:#111827;color:#ffffff;padding:25px;text-align:center;">
          <h1 style="margin:0;font-size:24px;">Sizlio POS</h1>
          <p style="margin:7px 0 0;color:#d1d5db;">Account Details</p>
        </div>

        <div style="padding:30px;">
          <h2 style="margin-top:0;color:#111827;">Restaurant Created Successfully</h2>
          <p style="line-height:1.6;">
            Your Sizlio POS account has been created successfully.
            Below you will find all login details for your restaurant.
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:25px 0;">

          <h3>Restaurant Details</h3>
          <table cellpadding="10" style="width:100%;border-collapse:collapse;">
            <tr>
              <td>Restaurant</td>
              <td><strong>${escapeHtml(restaurant.name)}</strong></td>
            </tr>
            <tr>
              <td>Plan</td>
              <td><strong>${escapeHtml(restaurant.plan || "-")}</strong></td>
            </tr>
            <tr>
              <td>Expiry</td>
              <td><strong>${escapeHtml(restaurant.expiry_date ? new Date(restaurant.expiry_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-")}</strong></td>
            </tr>
          </table>

          ${managerSection}

          ${staffSections.join("")}

          <div style="margin-top:30px;padding:18px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;">
            <strong>Security Notice</strong>
            <p style="margin-bottom:0;line-height:1.5;">
              Please keep these login credentials secure and do not share them with unauthorized persons.
            </p>
          </div>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0 20px;">

          <p>
            Regards,<br>
            <strong>Sizlio Team</strong>
          </p>

          <p style="font-size:12px;color:#6b7280;">
            This is an automated email. Please do not reply.<br>
            For inquiries, contact <a href="mailto:sales@sizlio.com" style="color:#2563eb;">sales@sizlio.com</a>
          </p>
        </div>

      </div>
    </body>
    </html>
  `;

  /* =====================================================
     SEND EMAIL
  ===================================================== */

  const result = await resend.emails.send({
    from: FROM_NO_REPLY,
    reply_to: "sales@sizlio.com",
    to: restaurant.email,
    subject: `Sizlio POS - ${restaurant.name} Login Details`,
    html
  });

  if (result.error) {
    throw new Error(result.error.message || "Resend API error");
  }

  return result;
};

// =====================================================
// SEND ORDER CONFIRMATION
// =====================================================

const sendOrderConfirmation = async ({
  to,
  customerName,
  orderId,
  orderTotal,
  restaurantName,
  items
}) => {

  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">
        ${escapeHtml(item.name)}${item.variant_label ? ` (${escapeHtml(item.variant_label)})` : ''}
        × ${item.quantity}
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;">
        Rs ${Number(item.price * item.quantity).toLocaleString()}
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:600px;margin:30px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
        <div style="background:#111827;color:#ffffff;padding:25px;text-align:center;">
          <h1 style="margin:0;font-size:22px;">${escapeHtml(restaurantName)}</h1>
          <p style="margin:7px 0 0;color:#d1d5db;font-size:14px;">Order Confirmation</p>
        </div>
        <div style="padding:30px;">
          <p>Hi ${escapeHtml(customerName || 'Customer')},</p>
          <p>Your order <strong>#${escapeHtml(orderId)}</strong> has been received successfully.</p>

          <table cellpadding="0" cellspacing="0" style="width:100%;margin-top:20px;">
            <thead>
              <tr>
                <th align="left" style="padding-bottom:8px;border-bottom:2px solid #111827;">Item</th>
                <th align="right" style="padding-bottom:8px;border-bottom:2px solid #111827;">Amount</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>

          <div style="margin-top:20px;padding-top:15px;border-top:2px solid #111827;text-align:right;">
            <strong style="font-size:18px;">Total: Rs ${Number(orderTotal).toLocaleString()}</strong>
          </div>

          <p style="margin-top:30px;font-size:13px;color:#6b7280;">
            Thank you for ordering from ${escapeHtml(restaurantName)}!
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const result = await resend.emails.send({
    from: FROM_NO_REPLY,
    reply_to: "sales@sizlio.com",
    to,
    subject: `Order #${orderId} Confirmed - ${restaurantName}`,
    html
  });

  if (result.error) {
    throw new Error(result.error.message || "Resend API error");
  }

  return result;
};

// =====================================================
// SEND PASSWORD RESET
// Note: Uses FROM_SUPPORT which falls back to FROM_NO_REPLY
// =====================================================

const sendPasswordReset = async ({
  to,
  username,
  resetUrl,
  restaurantName
}) => {

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:560px;margin:30px auto;background:#ffffff;border-radius:14px;overflow:hidden;">
        <div style="background:#111827;color:#ffffff;padding:25px;text-align:center;">
          <h1 style="margin:0;font-size:22px;">Password Reset</h1>
        </div>
        <div style="padding:30px;">
          <p>Hi,</p>
          <p>We received a request to reset the password for your account <strong>${escapeHtml(username)}</strong> at ${escapeHtml(restaurantName)}.</p>

          <div style="text-align:center;margin:30px 0;">
            <a href="${escapeAttribute(resetUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
              Reset Password
            </a>
          </div>

          <p style="font-size:13px;color:#6b7280;">
            This link is valid for 30 minutes. If you didn't request this, please ignore this email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const result = await resend.emails.send({
    from: FROM_SUPPORT,
    reply_to: "sales@sizlio.com",
    to,
    subject: `Password Reset - ${restaurantName}`,
    html
  });

  if (result.error) {
    throw new Error(result.error.message || "Resend API error");
  }

  return result;
};

// =====================================================
// ESCAPE HELPERS
// =====================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

module.exports = {
  sendRestaurantCredentials,
  sendOrderConfirmation,
  sendPasswordReset,
  FROM_NO_REPLY,
  FROM_SALES,
  FROM_SUPPORT,
  FROM_DEFAULT
};