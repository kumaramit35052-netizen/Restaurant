const express = require("express");
const fs = require("fs");
const path = require("path");
const session = require("express-session");
const multer = require("multer");

const app = express();
const PORT = 3000;
const DEFAULT_SETTINGS = {
  restaurantName: "Ferns Restaurant",
  address: "Main Market, Your City",
  phone: "+91 98765 43210",
  email: "billing@fernsrestaurant.com",
  gst: "Add your GST number",
  fssai: "Add your FSSAI number",
  tableCount: 20,
  defaultSeatsPerTable: 4,
  lateFeeAmount: 100,
  lateGraceMinutes: 20,
  tableConfigs: [],
  taxName: "GST",
  taxRate: 5,
  serviceNote: "Thank you for dining with us. Please visit again."
};
const MENU_FILE = path.join(__dirname, "menu.json");
const ORDERS_FILE = path.join(__dirname, "orders.json");
const BOOKINGS_FILE = path.join(__dirname, "bookings.json");
const CUSTOMERS_FILE = path.join(__dirname, "customers.json");
const INVENTORY_FILE = path.join(__dirname, "inventory.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const BILLS_DIR = path.join(__dirname, "bills");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(BILLS_DIR)) fs.mkdirSync(BILLS_DIR);
if (!fs.existsSync(MENU_FILE)) fs.writeFileSync(MENU_FILE, "[]");
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");
if (!fs.existsSync(BOOKINGS_FILE)) fs.writeFileSync(BOOKINGS_FILE, "[]");
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, "[]");
if (!fs.existsSync(INVENTORY_FILE)) fs.writeFileSync(INVENTORY_FILE, "[]");
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-z0-9.-]/gi, "-");
      cb(null, `${Date.now()}-${safeName}`);
    }
  })
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static("views"));
app.use("/uploads", express.static("uploads"));
app.use("/bills", express.static("bills"));
app.use(session({
  secret: "restaurant-secret-change-this",
  resave: false,
  saveUninitialized: false
}));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8") || "[]");
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function settings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE) };
}

function restaurantName() {
  return settings().restaurantName || DEFAULT_SETTINGS.restaurantName;
}

function safe(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect("/login");
  next();
}

function requireCustomer(req, res, next) {
  if (!req.session.customerPhone) return res.redirect("/customer/login");
  next();
}

function canCustomerDownloadBill(req, order) {
  return order
    && order.billStatus === "Paid"
    && order.customerPhone === req.session.customerPhone;
}

function page(title, body) {
  const business = settings();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safe(title)} | ${safe(business.restaurantName)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;700;800&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="brand-bar">
    <a href="/" class="brand-mark">
      <img src="/restaurant-logo.svg" alt="${safe(business.restaurantName)} logo">
      <span>${safe(business.restaurantName)}</span>
    </a>
  </header>
  <main class="shell">${body}</main>
</body>
</html>`;
}

function money(value) {
  return `Rs. ${Number(value || 0).toFixed(0)}`;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("en-IN") : "Not available";
}

function formatDateLabel(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function currentFinancialYearStart(date = new Date()) {
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return year;
}

function financialYearLabel(startYear) {
  return `FY ${startYear}-${String(startYear + 1).slice(-2)}`;
}

function financialYearMonths(startYear) {
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(startYear, 3 + index, 1);
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      label: date.toLocaleDateString("en-IN", { month: "short", year: "numeric" })
    };
  });
}

function salesReportData(startYear = currentFinancialYearStart()) {
  const paidOrders = readJson(ORDERS_FILE).filter(order => order.billStatus === "Paid" && order.paidAt);
  const months = financialYearMonths(startYear).map(month => ({
    ...month,
    sales: 0,
    orders: 0
  }));
  const monthMap = new Map(months.map(month => [month.key, month]));
  const fyStart = new Date(startYear, 3, 1);
  const fyEnd = new Date(startYear + 1, 3, 1);
  const today = todayDate();
  const todayOrders = [];
  let fySales = 0;
  let fyOrders = 0;

  paidOrders.forEach(order => {
    const paidAt = new Date(order.paidAt);
    const total = Number(order.total || billAmounts(order).grandTotal);
    const key = `${paidAt.getFullYear()}-${String(paidAt.getMonth() + 1).padStart(2, "0")}`;

    if (paidAt >= fyStart && paidAt < fyEnd) {
      fySales += total;
      fyOrders += 1;
      const month = monthMap.get(key);
      if (month) {
        month.sales += total;
        month.orders += 1;
      }
    }

    if (paidAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === today) {
      todayOrders.push(order);
    }
  });

  const todaySales = todayOrders.reduce((sum, order) => sum + Number(order.total || billAmounts(order).grandTotal), 0);
  const topItems = new Map();

  paidOrders
    .filter(order => {
      const paidAt = new Date(order.paidAt);
      return paidAt >= fyStart && paidAt < fyEnd;
    })
    .forEach(order => {
      order.items.forEach(item => {
        const current = topItems.get(item.name) || { name: item.name, qty: 0, sales: 0 };
        current.qty += Number(item.qty || 0);
        current.sales += Number(item.price || 0) * Number(item.qty || 0);
        topItems.set(item.name, current);
      });
    });

  return {
    startYear,
    label: financialYearLabel(startYear),
    months,
    fySales,
    fyOrders,
    today,
    todaySales,
    todayOrders: todayOrders.length,
    topItems: Array.from(topItems.values()).sort((a, b) => b.sales - a.sales).slice(0, 5)
  };
}

function orderSubtotal(order) {
  return order.items.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0);
}

function normalizePartySize(value) {
  const seats = Number(String(value || "").trim());
  return Number.isInteger(seats) && seats > 0 ? seats : null;
}

function tableConfigs(business = settings()) {
  const count = Math.max(1, Number(business.tableCount || 1));
  const saved = Array.isArray(business.tableConfigs) ? business.tableConfigs : [];

  return Array.from({ length: count }, (_, index) => {
    const table = index + 1;
    const savedConfig = saved.find(item => normalizeTable(item.table) === table) || {};

    return {
      table,
      seats: Math.max(1, Number(savedConfig.seats || business.defaultSeatsPerTable || 4)),
      reservePrice: Math.max(0, Number(savedConfig.reservePrice || 0))
    };
  });
}

function tableConfigMap(business = settings()) {
  return new Map(tableConfigs(business).map(config => [config.table, config]));
}

function bookingPeopleCount(booking) {
  return normalizePartySize(booking.partySize || booking.peopleCount || booking.seats) || 1;
}

function bookingIsActive(booking) {
  return booking && !["Cancelled", "Completed", "Paid"].includes(booking.status);
}

function bookingGraceDeadline(booking, business = settings()) {
  const slot = slotMinutes(booking?.slot);
  const date = normalizeBookingDate(booking?.date);

  if (!slot || !date) return null;

  const startOfDay = new Date(`${date}T00:00:00+05:30`);
  return new Date(startOfDay.getTime() + (slot.endMinutes + Number(business.lateGraceMinutes || 20)) * 60000);
}

function bookingForOrder(order, bookings = readJson(BOOKINGS_FILE)) {
  if (!order?.bookingId) return null;
  return bookings.find(booking => booking.id === order.bookingId) || null;
}

function bookingChargeForOrder(order, business = settings(), bookings = readJson(BOOKINGS_FILE)) {
  if (order?.bookingCharge !== undefined) return Number(order.bookingCharge || 0);

  const booking = bookingForOrder(order, bookings);
  if (!booking) return 0;
  if (booking.reservePrice !== undefined) return Number(booking.reservePrice || 0);

  const config = tableConfigMap(business).get(normalizeTable(booking.table));
  return Number(config?.reservePrice || 0);
}

function lateFeeForOrder(order, business = settings(), bookings = readJson(BOOKINGS_FILE), atTime = new Date()) {
  if (order?.lateFee !== undefined) return Number(order.lateFee || 0);

  const booking = bookingForOrder(order, bookings);
  if (!booking) return 0;

  const deadline = bookingGraceDeadline(booking, business);
  if (!deadline) return 0;

  const paidOrCurrent = order.paidAt ? new Date(order.paidAt) : atTime;
  return paidOrCurrent > deadline ? Number(business.lateFeeAmount || 100) : 0;
}

function billAmounts(order, business = settings()) {
  const bookings = readJson(BOOKINGS_FILE);
  const subtotal = Number(order.subtotal || orderSubtotal(order));
  const taxRate = Number(order.taxRate ?? business.taxRate ?? 0);
  const taxAmount = Math.round((subtotal * taxRate) / 100);
  const reserveCharge = bookingChargeForOrder(order, business, bookings);
  const lateFee = lateFeeForOrder(order, business, bookings);
  const grandTotal = subtotal + taxAmount + reserveCharge + lateFee;

  return { subtotal, taxRate, taxAmount, reserveCharge, lateFee, grandTotal };
}

function payableTotal(order) {
  return money(billAmounts(order).grandTotal);
}

function normalizeTable(value) {
  const table = Number(String(value || "").trim());
  return Number.isInteger(table) && table > 0 ? table : null;
}

function allTables(business = settings()) {
  const count = Math.max(1, Number(business.tableCount || 1));
  return Array.from({ length: count }, (_, index) => index + 1);
}

function occupiedTables(orders = readJson(ORDERS_FILE)) {
  return new Set(
    orders
      .filter(order => order.billStatus !== "Paid")
      .map(order => normalizeTable(order.table))
      .filter(Boolean)
  );
}

function availableTables(business = settings(), orders = readJson(ORDERS_FILE)) {
  const occupied = occupiedTables(orders);
  return allTables(business).filter(table => !occupied.has(table));
}

function highestActiveTable(orders = readJson(ORDERS_FILE)) {
  return orders
    .filter(order => order.billStatus !== "Paid")
    .map(order => normalizeTable(order.table))
    .filter(Boolean)
    .reduce((max, table) => Math.max(max, table), 0);
}

function todayDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function normalizeBookingDate(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function bookingSlots() {
  const slots = [];

  for (let hour = 9; hour <= 22; hour += 1) {
    const startHour = String(hour).padStart(2, "0");
    const endHour = String((hour + 2) % 24).padStart(2, "0");
    const startLabel = hour < 12 ? `${hour}:00 AM` : hour === 12 ? "12:00 PM" : `${hour - 12}:00 PM`;
    const nextHour = hour + 2;
    const endLabel = nextHour < 12 ? `${nextHour}:00 AM` : nextHour === 12 ? "12:00 PM" : nextHour < 24 ? `${nextHour - 12}:00 PM` : "12:00 AM";

    slots.push({
      value: `${startHour}:00-${endHour}:00`,
      label: `${startLabel} - ${endLabel}`
    });
  }

  return slots;
}

function validBookingSlot(value) {
  return bookingSlots().some(slot => slot.value === value);
}

function slotMinutes(slotValue) {
  const match = /^(\d{2}):00-(\d{2}):00$/.exec(String(slotValue || "").trim());
  if (!match) return null;

  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  const startMinutes = startHour * 60;
  const endMinutes = (endHour <= startHour ? endHour + 24 : endHour) * 60;

  return { startMinutes, endMinutes };
}

function bookingSeatAvailability(date, slot, business = settings(), bookings = readJson(BOOKINGS_FILE)) {
  const requestedSlot = slotMinutes(slot);
  const configs = tableConfigs(business);

  if (!date || !requestedSlot) {
    return configs.map(config => ({
      ...config,
      reservedSeats: 0,
      availableSeats: config.seats
    }));
  }

  return configs.map(config => {
    const reservedSeats = bookings
      .filter(booking => {
        if (!bookingIsActive(booking) || booking.date !== date) return false;
        if (normalizeTable(booking.table) !== config.table) return false;
        const bookedSlot = slotMinutes(booking.slot);
        if (!bookedSlot) return false;
        return requestedSlot.startMinutes < bookedSlot.endMinutes && bookedSlot.startMinutes < requestedSlot.endMinutes;
      })
      .reduce((sum, booking) => sum + bookingPeopleCount(booking), 0);

    return {
      ...config,
      reservedSeats,
      availableSeats: Math.max(0, config.seats - reservedSeats)
    };
  });
}

function availableBookingTables(date, slot, business = settings(), bookings = readJson(BOOKINGS_FILE), partySize = 1) {
  const seatsNeeded = normalizePartySize(partySize) || 1;
  return bookingSeatAvailability(date, slot, business, bookings)
    .filter(config => config.availableSeats >= seatsNeeded);
}

function formatBookingSlot(slotValue) {
  return bookingSlots().find(slot => slot.value === slotValue)?.label || slotValue;
}

function formatBookingDate(dateValue) {
  if (!dateValue) return "";
  return new Date(`${dateValue}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function cartItems(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function cartCount(req) {
  return cartItems(req).reduce((sum, item) => sum + item.qty, 0);
}

function customerActiveBooking(req) {
  if (!req.session.activeBookingId) return null;

  const booking = readJson(BOOKINGS_FILE).find(item =>
    item.id === req.session.activeBookingId
    && item.customerPhone === req.session.customerPhone
    && bookingIsActive(item)
  );

  if (!booking) {
    delete req.session.activeBookingId;
    return null;
  }

  return booking;
}

function billText(order) {
  const business = settings();
  const amount = billAmounts(order, business);
  const paidAt = order.paidAt ? new Date(order.paidAt).toLocaleString("en-IN") : "Not paid";
  const linkedBooking = bookingForOrder(order);
  const lines = [
    business.restaurantName.toUpperCase(),
    business.address,
    `Phone: ${business.phone} | Email: ${business.email}`,
    `GSTIN: ${business.gst} | FSSAI: ${business.fssai}`,
    "------------------------------------------------------------",
    "TAX INVOICE / BILL",
    "------------------------------------------------------------",
    `Bill No: ${order.id}`,
    `Order Date: ${new Date(order.createdAt).toLocaleString("en-IN")}`,
    `Paid Date: ${paidAt}`,
    `Customer: ${order.customerName || "Customer"}`,
    `Mobile: ${order.customerPhone || "Not saved"}`,
    `Table: ${order.table}`,
    linkedBooking ? `Reservation: ${linkedBooking.id} | ${formatBookingDate(linkedBooking.date)} | ${formatBookingSlot(linkedBooking.slot)}` : "Reservation: Walk-in",
    "------------------------------------------------------------",
    "Item                         Qty    Rate       Amount",
    "------------------------------------------------------------"
  ];

  order.items.forEach(item => {
    const name = item.name.slice(0, 28).padEnd(28, " ");
    const qty = String(item.qty).padStart(3, " ");
    const rate = money(item.price).padStart(9, " ");
    const amount = money(item.price * item.qty).padStart(11, " ");
    lines.push(`${name} ${qty} ${rate} ${amount}`);
  });

  lines.push("------------------------------------------------------------");
  lines.push(`Subtotal: ${money(amount.subtotal).padStart(47, " ")}`);
  lines.push(`${business.taxName} (${amount.taxRate}%): ${money(amount.taxAmount).padStart(42, " ")}`);
  if (amount.reserveCharge) lines.push(`Reservation Charge: ${money(amount.reserveCharge).padStart(35, " ")}`);
  if (amount.lateFee) lines.push(`Late Payment Fee: ${money(amount.lateFee).padStart(36, " ")}`);
  lines.push(`Grand Total: ${money(amount.grandTotal).padStart(45, " ")}`);

  if (order.customerNote) {
    lines.push("");
    lines.push("Customer Instructions:");
    lines.push(order.customerNote);
  }

  lines.push("");
  lines.push(business.serviceNote);
  return lines.join("\n");
}

function billDetailsHtml(order) {
  const linkedBooking = bookingForOrder(order);

  return `
    <div class="bill-meta-grid">
      <p><strong>Bill No:</strong> ${order.id}</p>
      <p><strong>Order Date:</strong> ${new Date(order.createdAt).toLocaleString("en-IN")}</p>
      <p><strong>Paid Date:</strong> ${order.paidAt ? new Date(order.paidAt).toLocaleString("en-IN") : "Not paid"}</p>
      <p><strong>Table:</strong> ${order.table}</p>
      <p><strong>Customer:</strong> ${order.customerName || "Customer"}</p>
      <p><strong>Mobile:</strong> ${order.customerPhone || "Not saved"}</p>
      <p><strong>Reservation:</strong> ${linkedBooking ? linkedBooking.id : "Walk-in"}</p>
      <p><strong>Reserved Slot:</strong> ${linkedBooking ? `${formatBookingDate(linkedBooking.date)} | ${formatBookingSlot(linkedBooking.slot)}` : "Not linked"}</p>
    </div>
  `;
}

/*
function oldBillText(order) {
  const lines = [
    "Restaurant Bill",
    `Order: ${order.id}`,
    `Customer: ${order.customerName || "Customer"}`,
    `Phone: ${order.customerPhone || "Not saved"}`,
    `Table: ${order.table}`,
    "",
    "Items:"
  ];

  order.items.forEach(item => {
    lines.push(`${item.qty} x ${item.name} - ${money(item.price * item.qty)}`);
  });

  if (order.customerNote) {
    lines.push("");
    lines.push(`Customer note: ${order.customerNote}`);
  }

  lines.push("");
  lines.push(`Total: ${money(order.total)}`);
  lines.push(`Date: ${new Date(order.createdAt).toLocaleString("en-IN")}`);
  return lines.join("\n");
}
*/

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function createSimplePdf(filePath, text) {
  const contentLines = text.split("\n").map((line, index) => {
    const y = 790 - index * 16;
    const fontSize = index === 0 ? 18 : 10;
    return `BT /F1 ${fontSize} Tf 48 ${y} Td (${escapePdfText(line)}) Tj ET`;
  }).join("\n");

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(contentLines)} >> stream\n${contentLines}\nendstream endobj`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach(object => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${object}\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  fs.writeFileSync(filePath, pdf, "binary");
}

app.get("/", (req, res) => {
  const business = settings();

  res.send(page("Restaurant", `
    <section class="hero-choice">
      <p class="eyebrow">Premium dine-in experience</p>
      <h1>${business.restaurantName}</h1>
      <p>Browse the menu, reserve your table, place your order, and track everything from one guided experience.</p>
      <section class="hero-panel card">
        <div>
          <strong>Smoother ordering from entry to billing</strong>
          <p>Guests can sign in, reserve seats, review their cart, send instructions to the kitchen, and download paid bills in one simple flow.</p>
        </div>
        <div class="feature-chips">
          <span>Live order tracking</span>
          <span>Reservations by seat capacity</span>
          <span>Digital billing</span>
          <span>Admin reporting</span>
        </div>
      </section>
      <div class="choice-grid">
        <a class="card choice-card" href="/customer/login">
          <strong>Guest Access</strong>
          <span>Sign in with your name, mobile number, and OTP to start ordering.</span>
        </a>
        <a class="card choice-card" href="/login">
          <strong>Admin Login</strong>
          <span>Manage menu, kitchen workflow, inventory, reservations, and sales reports.</span>
        </a>
      </div>
      <section class="guide-grid">
        <article class="card guide-card">
          <p class="eyebrow">Step 1</p>
          <h3>Sign in securely</h3>
          <p>Create a quick guest session with OTP verification.</p>
        </article>
        <article class="card guide-card">
          <p class="eyebrow">Step 2</p>
          <h3>Reserve or order</h3>
          <p>Pick a table, reserve seats, and add dishes with special instructions.</p>
        </article>
        <article class="card guide-card">
          <p class="eyebrow">Step 3</p>
          <h3>Track and pay</h3>
          <p>Follow kitchen status updates and collect your paid bill whenever it is ready.</p>
        </article>
      </section>
    </section>
  `));
});

app.get("/customer/login", (req, res) => {
  res.send(page("Customer Login", `
    <section class="narrow">
      <form method="POST" action="/customer/login" class="card form-card">
        <div class="login-brand">
          <img src="/restaurant-logo.svg" alt="${safe(settings().restaurantName)} logo">
        </div>
        <h1>Guest Login</h1>
        <p class="hint">Enter your name and mobile number. When you sign in with the same number again, your order and reservation history will stay available.</p>
        <label>Your Name <input name="name" required></label>
        <label>Mobile Number <input name="phone" inputmode="numeric" pattern="[0-9]{10}" required></label>
        <button class="primary" type="submit">Send OTP</button>
        <a href="/">Back to home</a>
      </form>
    </section>
  `));
});

app.post("/customer/login", (req, res) => {
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  const name = String(req.body.name || "").trim();

  if (!name || phone.length !== 10) {
    return res.send(page("Invalid Number", `
      <h1>Enter your name and a valid 10-digit mobile number.</h1>
      <a class="button" href="/customer/login">Try again</a>
    `));
  }

  const customers = readJson(CUSTOMERS_FILE);
  let customer = customers.find(item => item.phone === phone);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  if (!customer) {
    customer = { phone, name, createdAt: new Date().toISOString() };
    customers.push(customer);
  }

  customer.name = name;
  customer.otp = otp;
  customer.otpCreatedAt = new Date().toISOString();
  writeJson(CUSTOMERS_FILE, customers);

  res.send(page("Verify OTP", `
    <section class="narrow">
      <form method="POST" action="/customer/verify" class="card form-card">
        <h1>Verify OTP</h1>
        <p class="hint">This is a demo setup, so the OTP is shown on-screen. A real SMS provider can be connected later.</p>
        <p class="otp-box">${otp}</p>
        <input type="hidden" name="phone" value="${phone}">
        <label>OTP <input name="otp" inputmode="numeric" required autofocus></label>
        <button class="primary" type="submit">Verify & Login</button>
      </form>
    </section>
  `));
});

app.post("/customer/verify", (req, res) => {
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  const customers = readJson(CUSTOMERS_FILE);
  const customer = customers.find(item => item.phone === phone);

  if (!customer || customer.otp !== String(req.body.otp || "").trim()) {
    return res.send(page("Wrong OTP", `
      <h1>Wrong OTP</h1>
      <p>The OTP did not match. Please try again.</p>
      <a class="button" href="/customer/login">Try again</a>
    `));
  }

  customer.lastLoginAt = new Date().toISOString();
  delete customer.otp;
  delete customer.otpCreatedAt;
  writeJson(CUSTOMERS_FILE, customers);

  req.session.customerPhone = phone;
  req.session.customerName = customer.name;
  res.redirect("/menu");
});

app.get("/customer", requireCustomer, (req, res) => {
  const orders = readJson(ORDERS_FILE).filter(order => order.customerPhone === req.session.customerPhone);
  const cards = orders.map(order => {
    const items = order.items.map(item => `<li>${item.qty} x ${item.name}</li>`).join("");
    const billButton = order.billStatus === "Paid"
      ? `<a class="button primary" href="/customer/bill/${order.id}/pdf">Download Bill</a>`
      : "";

    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${order.table}</h2>
          <span class="badge">${order.status}</span>
        </div>
        <p>Order #${order.id}</p>
        ${order.customerNote ? `<p class="note-box">${order.customerNote}</p>` : ""}
        <ul>${items}</ul>
        <strong>${payableTotal(order)}</strong>
        <a class="button" href="/order/${order.id}">View Status</a>
        ${billButton}
      </article>
    `;
  }).join("");

  res.send(page("Order History", `
    <nav class="topbar">
      <strong>${req.session.customerName || req.session.customerPhone}</strong>
      <span>
        <a href="/menu">Menu</a>
        <a href="/booking">Reservations</a>
        <a href="/customer/bookings">Reservation History</a>
        <a href="/customer">Order History</a>
        <a href="/customer/logout">Logout</a>
      </span>
    </nav>
    <section class="intro">
      <h1>Your Order History</h1>
      <p>Every order placed with this mobile number is listed here for easy tracking.</p>
    </section>
    <div class="grid">${cards || "<p>No orders have been placed from this mobile number yet.</p>"}</div>
  `));
});

app.get("/customer/bookings", requireCustomer, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const bookings = readJson(BOOKINGS_FILE)
    .filter(booking => booking.customerPhone === req.session.customerPhone)
    .sort((a, b) => `${b.date} ${b.slot}`.localeCompare(`${a.date} ${a.slot}`));

  const cards = bookings.map(booking => {
    const linkedOrder = booking.orderId ? orders.find(order => order.id === booking.orderId) : null;
    const orderButton = bookingIsActive(booking)
      ? `
        <form method="POST" action="/booking/${booking.id}/order">
          <button class="primary" type="submit">${linkedOrder ? "Add More Food" : "Order Food"}</button>
        </form>
      `
      : "";

    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${booking.table}</h2>
          <span class="badge">${booking.status}</span>
        </div>
        <p>${formatBookingDate(booking.date)} | ${formatBookingSlot(booking.slot)}</p>
        <p>${booking.partySize || 1} people reserved</p>
        <p>Reservation #${booking.id}</p>
        <p>Reservation charge ${money(booking.reservePrice || 0)}</p>
        ${booking.note ? `<p class="note-box">${booking.note}</p>` : ""}
        ${linkedOrder ? `<p class="hint">Linked order total: ${payableTotal(linkedOrder)} | Order #${linkedOrder.id}</p>` : "<p class='hint'>No food order has been placed for this reservation yet.</p>"}
        <div class="actions">
          ${orderButton}
          ${linkedOrder ? `<a class="button" href="/order/${linkedOrder.id}">View Linked Order</a>` : ""}
        </div>
      </article>
    `;
  }).join("");

  res.send(page("Reservation History", `
    <nav class="topbar">
      <strong>${req.session.customerName || req.session.customerPhone}</strong>
      <span>
        <a href="/menu">Menu</a>
        <a href="/booking">Reservations</a>
        <a href="/customer/bookings">Reservation History</a>
        <a href="/customer">Order History</a>
        <a href="/customer/logout">Logout</a>
      </span>
    </nav>
    <section class="intro">
      <h1>Reservation History</h1>
      <p>Review all your reservations here and start a linked food order whenever needed.</p>
    </section>
    <div class="grid">${cards || "<p>No reservations found yet.</p>"}</div>
  `));
});

app.get("/menu", requireCustomer, (req, res) => {
  const menu = readJson(MENU_FILE);
  const activeBooking = customerActiveBooking(req);

  const itemsHtml = menu.map((item, index) => `
    <article class="card menu-item">
      <img src="${item.image || "/placeholder-food.svg"}" alt="${item.name}">
      <div>
        <h3>${item.name}</h3>
        <p>${money(item.price)}</p>
        <form method="POST" action="/cart/add" class="cart-add">
          <input type="hidden" name="index" value="${index}">
          <label>Qty <input type="number" name="qty" min="1" value="1"></label>
          <button class="primary" type="submit">Add To Cart</button>
        </form>
      </div>
    </article>
  `).join("");

  res.send(page("Restaurant Menu", `
    <nav class="topbar">
      <strong>${req.session.customerName || "Customer"}</strong>
      <span>
        <a href="/cart">Cart (${cartCount(req)})</a>
        <a href="/booking">Reservations</a>
        <a href="/customer/bookings">Reservation History</a>
        <a href="/customer">Order History</a>
        <a href="/customer/logout">Logout</a>
      </span>
    </nav>

    <section class="intro">
      <h1>Menu</h1>
      <p>Choose your dishes, review the cart carefully, and send the order directly to the kitchen.</p>
    </section>

    <section class="order-form">
      ${activeBooking ? `
        <section class="card">
          <div class="order-head">
            <div>
              <p class="eyebrow">Active Reservation</p>
              <h2>Table ${activeBooking.table}</h2>
            </div>
            <span class="badge">${activeBooking.status}</span>
          </div>
          <p>${formatBookingDate(activeBooking.date)} | ${formatBookingSlot(activeBooking.slot)}</p>
          <p>${activeBooking.partySize || 1} people reserved | Reservation charge ${money(activeBooking.reservePrice || 0)}</p>
          <p class="hint">Any food order placed here will stay linked with this reservation for the reception team.</p>
        </section>
      ` : ""}
      <section class="card">
        <div class="order-head">
          <div>
            <p class="eyebrow">Ordering made simple</p>
            <h2>Place your order with confidence</h2>
          </div>
        </div>
        <ul class="clean-list compact-list">
          <li><span>Add dishes one by one and confirm the quantity before checkout.</span></li>
          <li><span>Use the cart page to choose a table or continue with your active reservation.</span></li>
          <li><span>Add notes like less spicy, no onion, or celebration plating before sending the order.</span></li>
        </ul>
      </section>
      <label class="table-input">
        Linked Table
        <input value="${activeBooking?.table || req.session.currentTable || ""}" placeholder="Selected during checkout" readonly>
      </label>
      <div class="grid">${itemsHtml || "<p>No menu items are available yet.</p>"}</div>
      <a class="button primary" href="/cart">Review Cart</a>
    </section>
  `));
});

app.get("/booking", requireCustomer, (req, res) => {
  const business = settings();
  const bookingDate = normalizeBookingDate(req.query.bookingDate) || todayDate();
  const bookingSlot = validBookingSlot(req.query.bookingSlot) ? req.query.bookingSlot : bookingSlots()[0].value;
  const partySize = normalizePartySize(req.query.partySize) || 2;
  const bookingTable = String(req.query.bookingTable || "");
  const slotOptions = bookingSlots().map(slot => {
    const selected = slot.value === bookingSlot ? "selected" : "";
    return `<option value="${slot.value}" ${selected}>${slot.label}</option>`;
  }).join("");
  const bookings = readJson(BOOKINGS_FILE);
  const tableAvailability = bookingSeatAvailability(bookingDate, bookingSlot, business, bookings);
  const bookingTables = availableBookingTables(bookingDate, bookingSlot, business, bookings, partySize);
  const availableBookingSet = new Set(bookingTables.map(item => item.table));
  const bookingTableOptions = tableAvailability.map(config => {
    const selected = String(config.table) === bookingTable ? "selected" : "";
    const canFit = availableBookingSet.has(config.table);
    return `<option value="${config.table}" ${selected} ${canFit ? "" : "disabled"}>Table ${config.table} - ${config.availableSeats}/${config.seats} seats available - Reserve ${money(config.reservePrice)}</option>`;
  }).join("");
  const myUpcomingBookings = bookings
    .filter(booking => booking.customerPhone === req.session.customerPhone && booking.status !== "Cancelled")
    .slice(0, 3)
    .map(booking => `<li>${formatBookingDate(booking.date)} | ${formatBookingSlot(booking.slot)} | Table ${booking.table} | ${booking.partySize || 1} people</li>`)
    .join("");
  const peopleOptions = Array.from({ length: 12 }, (_, index) => {
    const value = index + 1;
    return `<option value="${value}" ${value === partySize ? "selected" : ""}>${value} people</option>`;
  }).join("");

  res.send(page("Reservations", `
    <nav class="topbar">
      <strong>${req.session.customerName || "Customer"}</strong>
      <span>
        <a href="/cart">Cart (${cartCount(req)})</a>
        <a href="/booking">Reservations</a>
        <a href="/customer/bookings">Reservation History</a>
        <a href="/customer">Order History</a>
        <a href="/customer/logout">Logout</a>
      </span>
    </nav>

    <section class="intro">
      <h1>Reserve Your Table</h1>
      <p>Check seat availability by table and choose the best slot for your group.</p>
    </section>

    <section class="narrow booking-page">
      <section class="card booking-card">
        <div class="order-head">
          <div>
            <p class="eyebrow">Reservation planner</p>
            <h2>Reserve seats based on your group size</h2>
          </div>
          <span class="badge">9 AM to 12 AM</span>
        </div>
        <form method="POST" action="/booking" class="form-card">
          <div class="two-col">
            <label>
              Booking Date
              <input name="date" type="date" min="${todayDate()}" value="${bookingDate}" required>
            </label>
            <label>
              Time Slot
              <select name="slot" required>
                ${slotOptions}
              </select>
            </label>
          </div>
          <label>
            Number Of People
            <select name="partySize" required>
              ${peopleOptions}
            </select>
          </label>
          <label>
            Choose Table
            <select name="table" required>
              <option value="">Select a table</option>
              ${bookingTableOptions}
            </select>
          </label>
          ${bookingTables.length ? `<p class="hint">${bookingTables.length} table(s) are available for your selected date, slot, and group size.</p>` : "<p class='note-box'>No table currently matches this date, slot, and group size. Please try another option.</p>"}
          <label>
            Reservation Note
            <textarea name="note" rows="3" placeholder="Birthday dinner, family table, window side, etc."></textarea>
          </label>
          <button class="primary" type="submit" ${bookingTables.length ? "" : "disabled"}>Reserve Seats</button>
        </form>
        <form method="GET" action="/booking" class="inline-filter">
          <div class="two-col">
            <label>
              Check Date
              <input name="bookingDate" type="date" min="${todayDate()}" value="${bookingDate}">
            </label>
            <label>
              Check Slot
              <select name="bookingSlot">
                ${slotOptions}
              </select>
            </label>
          </div>
          <label>
            People Count
            <select name="partySize">
              ${peopleOptions}
            </select>
          </label>
          <button type="submit">Check Availability</button>
        </form>
        ${myUpcomingBookings ? `<div><p class="hint">Your recent reservations</p><ul class="clean-list compact-list">${myUpcomingBookings}</ul></div>` : ""}
      </section>
    </section>
  `));
});

app.post("/booking/:id/order", requireCustomer, (req, res) => {
  const bookings = readJson(BOOKINGS_FILE);
  const booking = bookings.find(item => item.id === req.params.id && item.customerPhone === req.session.customerPhone);

  if (!booking || booking.status === "Cancelled") {
    return res.send(page("Reservation Missing", `
      <h1>Reservation not found</h1>
      <p>This reservation is no longer available.</p>
      <a class="button" href="/customer/bookings">Back to reservation history</a>
    `));
  }

  req.session.activeBookingId = booking.id;
  req.session.currentTable = String(booking.table);
  res.redirect("/menu");
});

app.post("/cart/add", requireCustomer, (req, res) => {
  const menu = readJson(MENU_FILE);
  const index = Number(req.body.index);
  const qty = Math.max(1, Number(req.body.qty || 1));
  const item = menu[index];

  if (!item) return res.redirect("/menu");

  const cart = cartItems(req);
  const existing = cart.find(cartItem => cartItem.index === index);

  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({
      index,
      name: item.name,
      price: Number(item.price),
      image: item.image || "/placeholder-food.svg",
      qty
    });
  }

  res.redirect("/cart");
});

app.post("/booking", requireCustomer, (req, res) => {
  const business = settings();
  const bookings = readJson(BOOKINGS_FILE);
  const date = normalizeBookingDate(req.body.date);
  const slot = String(req.body.slot || "").trim();
  const table = normalizeTable(req.body.table);
  const partySize = normalizePartySize(req.body.partySize);
  const validTables = new Set(allTables(business));
  const selectedConfig = tableConfigMap(business).get(table);
  const availableTablesForSlot = availableBookingTables(date, slot, business, bookings, partySize);
  const selectedAvailability = availableTablesForSlot.find(item => item.table === table);

  if (!date || date < todayDate()) {
    return res.send(page("Booking Error", `
      <h1>Select a valid reservation date</h1>
      <p>Reservations can only be created for today or a future date.</p>
      <a class="button" href="/booking">Back to booking</a>
    `));
  }

  if (!validBookingSlot(slot)) {
    return res.send(page("Booking Error", `
      <h1>Select a valid time slot</h1>
      <p>Reservations are available only in 2-hour slots between 9:00 AM and 12:00 AM.</p>
      <a class="button" href="/booking">Back to booking</a>
    `));
  }

  if (!partySize) {
    return res.send(page("Booking Error", `
      <h1>Select a valid party size</h1>
      <p>At least one guest is required for a reservation.</p>
      <a class="button" href="/booking">Back to booking</a>
    `));
  }

  if (!table || !validTables.has(table)) {
    return res.send(page("Booking Error", `
      <h1>Select a valid table</h1>
      <p>Your reservation must be assigned to one of the tables configured by the restaurant.</p>
      <a class="button" href="/booking">Back to booking</a>
    `));
  }

  if (!selectedConfig || partySize > selectedConfig.seats || !selectedAvailability) {
    return res.send(page("Booking Error", `
      <h1>Seats are unavailable</h1>
      <p>The selected table does not have enough seats left for this date and slot.</p>
      <a class="button" href="/booking">Choose another table</a>
    `));
  }

  bookings.unshift({
    id: `BK-${Date.now()}`,
    customerPhone: req.session.customerPhone,
    customerName: req.session.customerName || "",
    table: String(table),
    partySize,
    date,
    slot,
    note: String(req.body.note || "").trim(),
    reservePrice: Number(selectedConfig.reservePrice || 0),
    status: "Reserved",
    createdAt: new Date().toISOString()
  });

  writeJson(BOOKINGS_FILE, bookings);
  res.redirect("/customer/bookings");
});

app.get("/cart", requireCustomer, (req, res) => {
  const cart = cartItems(req);
  const business = settings();
  const activeBooking = customerActiveBooking(req);
  const tables = availableTables(business);
  const availableTableSet = new Set(tables);
  const tableOptions = allTables(business).map(table => {
    const selected = String(activeBooking?.table || req.session.currentTable || "") === String(table) ? "selected" : "";
    const isAvailable = availableTableSet.has(table);
    return `<option value="${table}" ${selected} ${isAvailable ? "" : "disabled"}>Table ${table}${isAvailable ? "" : " - Occupied"}</option>`;
  }).join("");
  const summaryOrder = {
    items: cart.map(item => ({ price: item.price, qty: item.qty })),
    subtotal: cart.reduce((sum, item) => sum + item.price * item.qty, 0),
    taxRate: Number(business.taxRate || 0),
    bookingCharge: activeBooking ? Number(activeBooking.reservePrice || 0) : 0,
    lateFee: 0
  };
  const amount = billAmounts(summaryOrder, business);
  const rows = cart.map((item, index) => `
    <article class="card cart-row">
      <img src="${item.image}" alt="${item.name}">
      <div>
        <h3>${item.name}</h3>
        <p>${money(item.price)} each</p>
        <form method="POST" action="/cart/update" class="qty-controls">
          <input type="hidden" name="index" value="${index}">
          <button name="action" value="decrease" type="submit">-</button>
          <strong>${item.qty}</strong>
          <button name="action" value="increase" type="submit">+</button>
          <button class="danger-button" name="action" value="remove" type="submit">Remove</button>
        </form>
      </div>
      <strong>${money(item.price * item.qty)}</strong>
    </article>
  `).join("");

  res.send(page("Cart", `
    <nav class="topbar">
      <strong>Your Cart</strong>
      <span>
        <a href="/menu">Add More</a>
        <a href="/booking">Reservations</a>
        <a href="/customer/bookings">Reservation History</a>
        <a href="/customer">Order History</a>
      </span>
    </nav>
    <section class="cart-layout">
      <div>${rows || "<p>Your cart is currently empty.</p>"}</div>
      <aside class="cart-side-stack">
        <section class="card">
          <p class="eyebrow">Quick checkout</p>
          <ul class="clean-list compact-list">
            <li><span>Choose a free table if you do not already have an active reservation.</span></li>
            <li><span>Add kitchen notes only when they affect preparation or service.</span></li>
            <li><span>Review subtotal, tax, and reservation charges before sending the order.</span></li>
          </ul>
        </section>
        <section class="card cart-summary">
          <h2>Order Summary</h2>
          <form method="POST" action="/order" class="form-card">
            ${activeBooking ? `
              <div class="note-box">
                <strong>Active reservation:</strong> Table ${activeBooking.table} | ${formatBookingDate(activeBooking.date)} | ${formatBookingSlot(activeBooking.slot)} | ${activeBooking.partySize || 1} people
              </div>
              <input type="hidden" name="table" value="${activeBooking.table}">
            ` : `
              <label>
                Table Number
                <select name="table" required>
                  <option value="">Select a table</option>
                  ${tableOptions}
                </select>
              </label>
              ${tables.length ? `<p class="hint">Only currently available tables can be selected here.</p>` : "<p class='note-box'>All tables are occupied right now. A table will open once reception marks an order as paid.</p>"}
            `}
            <label>
              Description / Special Instructions
              <textarea name="customerNote" rows="4" placeholder="Example: less spicy, no onion, birthday plate, etc."></textarea>
            </label>
            <p>Total items: ${cartCount(req)}</p>
            <div class="price-breakdown">
              <p>Food Subtotal <strong>${money(amount.subtotal)}</strong></p>
              <p>${safe(business.taxName)} (${amount.taxRate}%) <strong>${money(amount.taxAmount)}</strong></p>
              ${amount.reserveCharge ? `<p>Reservation Charge <strong>${money(amount.reserveCharge)}</strong></p>` : ""}
              <h2>Grand Total <strong>${money(amount.grandTotal)}</strong></h2>
            </div>
            <button class="primary" type="submit" ${cart.length && (activeBooking || tables.length) ? "" : "disabled"}>Send Order To Kitchen</button>
          </form>
          <form method="POST" action="/cart/clear">
            <button type="submit">Clear Cart</button>
          </form>
        </section>
      </aside>
    </section>
  `));
});

app.post("/cart/update", requireCustomer, (req, res) => {
  const cart = cartItems(req);
  const index = Number(req.body.index);
  const item = cart[index];

  if (item) {
    if (req.body.action === "increase") item.qty += 1;
    if (req.body.action === "decrease") item.qty -= 1;
    if (req.body.action === "remove" || item.qty <= 0) cart.splice(index, 1);
  }

  res.redirect("/cart");
});

app.post("/cart/clear", requireCustomer, (req, res) => {
  req.session.cart = [];
  res.redirect("/cart");
});

app.post("/order", requireCustomer, (req, res) => {
  const business = settings();
  const activeBooking = customerActiveBooking(req);
  const table = normalizeTable(activeBooking?.table || req.body.table);
  const validTables = new Set(allTables(business));
  const occupied = occupiedTables();
  const bookings = readJson(BOOKINGS_FILE);
  const selectedItems = cartItems(req).map(item => ({
    name: item.name,
    price: Number(item.price),
    qty: Number(item.qty)
  }));

  if (!table || selectedItems.length === 0) {
    return res.send(page("Order Error", `
      <h1>Order not placed</h1>
      <p>Please select a table and add at least one item before placing the order.</p>
      <a class="button" href="/cart">Back to cart</a>
    `));
  }

  if (!validTables.has(table)) {
    return res.send(page("Invalid Table", `
      <h1>Invalid table number</h1>
      <p>The selected table is not part of the current restaurant setup.</p>
      <a class="button" href="/cart">Back to cart</a>
    `));
  }

  if (occupied.has(table) && !activeBooking) {
    return res.send(page("Table Occupied", `
      <h1>Table ${table} is occupied</h1>
      <p>A new order can be placed only after the current table bill is completed.</p>
      <a class="button" href="/cart">Choose another table</a>
    `));
  }

  const orders = readJson(ORDERS_FILE);
  const subtotal = selectedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  const taxRate = Number(business.taxRate || 0);
  const taxAmount = Math.round((subtotal * taxRate) / 100);
  const bookingCharge = activeBooking ? Number(activeBooking.reservePrice || 0) : 0;
  const order = {
    id: Date.now().toString(),
    customerPhone: req.session.customerPhone,
    customerName: req.session.customerName || "",
    table: String(table),
    bookingId: activeBooking?.id || "",
    customerNote: String(req.body.customerNote || "").trim(),
    items: selectedItems,
    subtotal,
    taxRate,
    taxAmount,
    bookingCharge,
    total: subtotal + taxAmount + bookingCharge,
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  orders.unshift(order);
  writeJson(ORDERS_FILE, orders);

  if (activeBooking) {
    const booking = bookings.find(item => item.id === activeBooking.id);
    if (booking) {
      booking.orderId = order.id;
      booking.status = "Ordered";
      booking.orderedAt = new Date().toISOString();
      writeJson(BOOKINGS_FILE, bookings);
    }
  }

  req.session.cart = [];
  req.session.currentTable = String(table);
  if (!activeBooking) delete req.session.activeBookingId;
  res.redirect(`/order/${order.id}`);
});

app.get("/order/:id", (req, res) => {
  const order = readJson(ORDERS_FILE).find(item => item.id === req.params.id);
  if (!order) return res.status(404).send(page("Order Missing", "<h1>Order not found</h1>"));
  const canView = req.session.isAdmin || order.customerPhone === req.session.customerPhone;
  const linkedBooking = bookingForOrder(order);

  if (!canView) return res.redirect("/customer/login");

  const items = order.items.map(item => `
    <li>${item.qty} x ${item.name} <strong>${money(item.price * item.qty)}</strong></li>
  `).join("");
  const billButton = canCustomerDownloadBill(req, order)
    ? `<a class="button primary" href="/customer/bill/${order.id}/pdf">Download Paid Bill</a>`
    : "";

  res.send(page("Order Status", `
    <nav class="topbar"><a href="/menu">Menu</a><a href="/customer/bookings">Reservation History</a><a href="/customer">Order History</a></nav>
    <section class="status-panel">
      <p class="badge">${order.status}</p>
      <h1>Table ${order.table}</h1>
      <p>${order.customerName || "Customer"} | ${order.customerPhone || "No phone saved"}</p>
      <p>Order #${order.id}</p>
      ${linkedBooking ? `<p>Reservation #${linkedBooking.id} | ${formatBookingDate(linkedBooking.date)} | ${formatBookingSlot(linkedBooking.slot)} | ${linkedBooking.partySize || 1} people</p>` : ""}
      ${order.customerNote ? `<p class="note-box">${order.customerNote}</p>` : ""}
      <ul class="clean-list">${items}</ul>
      <h2>Total: ${payableTotal(order)}</h2>
      <p class="hint">Refresh this page any time to see the latest kitchen status.</p>
      <a class="button" href="/order/${order.id}">Refresh Status</a>
      ${billButton}
    </section>
  `));
});

app.get("/kitchen", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE).filter(order => order.status !== "Served");
  const orderCards = orders.map(order => {
    const items = order.items.map(item => `<li>${item.qty} x ${item.name}</li>`).join("");
    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${order.table}</h2>
          <span class="badge">${order.status}</span>
        </div>
        <p>${order.customerName || "Customer"} | ${order.customerPhone || "No phone"}</p>
        <p>Order #${order.id}</p>
        ${order.customerNote ? `<p class="note-box">${order.customerNote}</p>` : ""}
        <ul>${items}</ul>
        <strong>${payableTotal(order)}</strong>
        <form method="POST" action="/kitchen/${order.id}/status" class="actions">
          <button name="status" value="Preparing">Preparing</button>
          <button name="status" value="Ready">Ready</button>
          <button name="status" value="Served">Served</button>
        </form>
      </article>
    `;
  }).join("");

  res.send(page("Kitchen Orders", `
    <nav class="topbar">
      <strong>Kitchen Display</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/admin/inventory">Inventory</a>
        <a href="/admin/reports">Reports</a>
        <a href="/kitchen/history">Order History</a>
        <a href="/reception">Reception</a>
        <a href="/admin/settings">Business Details</a>
      </span>
    </nav>
    <h1>Live Orders</h1>
    <div class="grid">${orderCards || "<p>No live orders at the moment.</p>"}</div>
  `));
});

app.get("/kitchen/history", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE).filter(order => order.status === "Served");
  const orderCards = orders.map(order => {
    const items = order.items.map(item => `<li>${item.qty} x ${item.name}</li>`).join("");
    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${order.table}</h2>
          <span class="badge">${order.status}</span>
        </div>
        <p>${order.customerName || "Customer"} | ${order.customerPhone || "No phone"}</p>
        <p>Order #${order.id}</p>
        ${order.customerNote ? `<p class="note-box">${order.customerNote}</p>` : ""}
        <ul>${items}</ul>
        <strong>${payableTotal(order)}</strong>
      </article>
    `;
  }).join("");

  res.send(page("Kitchen History", `
    <nav class="topbar">
      <strong>Served Orders</strong>
      <span>
        <a href="/kitchen">Live Orders</a>
        <a href="/admin">Admin</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/settings">Business Details</a>
      </span>
    </nav>
    <h1>Kitchen Order History</h1>
    <div class="grid">${orderCards || "<p>No served orders yet.</p>"}</div>
  `));
});

app.get("/reception", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE).filter(order => order.billStatus !== "Paid");
  const orderCards = orders.map(order => {
    const linkedBooking = bookingForOrder(order);
    const items = order.items.map(item => `<li>${item.qty} x ${item.name}</li>`).join("");
    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${order.table}</h2>
          <span class="badge">${order.status} | ${order.billStatus || "Bill Pending"}</span>
        </div>
        <p>${order.customerName || "Customer"} | ${order.customerPhone || "No phone"}</p>
        <p>Order #${order.id}</p>
        ${linkedBooking ? `<p>Reservation #${linkedBooking.id} | ${linkedBooking.partySize || 1} people | Reservation ${money(linkedBooking.reservePrice || 0)}</p>` : "<p>Walk-in order</p>"}
        ${order.customerNote ? `<p class="note-box">${order.customerNote}</p>` : ""}
        <ul>${items}</ul>
        <strong>${payableTotal(order)}</strong>
        <div class="actions">
          <a class="button" href="/bill/${order.id}">Open Bill</a>
          ${order.status === "Served" ? `
            <a class="button" href="/bill/${order.id}/pdf">Download PDF</a>
            <form method="POST" action="/bill/${order.id}/send">
              <button type="submit">Send PDF</button>
            </form>
            <form method="POST" action="/bill/${order.id}/paid">
              <button class="primary" type="submit">Mark Paid</button>
            </form>
          ` : `<p class="hint">Complete payment after the kitchen marks this order as served.</p>`}
        </div>
        ${order.billSentAt ? `<p class="hint">Bill PDF prepared on: ${new Date(order.billSentAt).toLocaleString("en-IN")}</p>` : ""}
      </article>
    `;
  }).join("");

  res.send(page("Reception", `
    <nav class="topbar">
      <strong>Reception Billing</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/kitchen">Kitchen</a>
        <a href="/admin/inventory">Inventory</a>
        <a href="/admin/reports">Reports</a>
        <a href="/reception/bookings">Reservations</a>
        <a href="/reception/history">Paid History</a>
        <a href="/admin/settings">Business Details</a>
      </span>
    </nav>
    <h1>Reception Live Orders</h1>
    <div class="grid">${orderCards || "<p>No active unpaid orders.</p>"}</div>
  `));
});

app.get("/reception/bookings", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const bookings = readJson(BOOKINGS_FILE)
    .sort((a, b) => `${a.date} ${a.slot}`.localeCompare(`${b.date} ${b.slot}`));

  const cards = bookings.map(booking => {
    const linkedOrder = booking.orderId ? orders.find(order => order.id === booking.orderId) : null;
    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${booking.table}</h2>
          <span class="badge">${booking.status}</span>
        </div>
        <p>${formatBookingDate(booking.date)} | ${formatBookingSlot(booking.slot)}</p>
        <p>${booking.customerName || "Customer"} | ${booking.customerPhone || "No phone"}</p>
        <p>${booking.partySize || 1} people | Reservation ${money(booking.reservePrice || 0)}</p>
        <p>Reservation #${booking.id}</p>
        ${booking.note ? `<p class="note-box">${booking.note}</p>` : ""}
        ${linkedOrder ? `<p class="hint">Food total: ${payableTotal(linkedOrder)} | Order #${linkedOrder.id} | ${linkedOrder.status}</p>` : "<p class='hint'>No food order has been placed yet.</p>"}
      </article>
    `;
  }).join("");

  res.send(page("Reception Reservations", `
    <nav class="topbar">
      <strong>Reception Reservations</strong>
      <span>
        <a href="/reception">Reception</a>
        <a href="/reception/history">Paid History</a>
        <a href="/admin">Admin</a>
        <a href="/admin/reports">Reports</a>
      </span>
    </nav>
    <div class="grid">${cards || "<p>No reservations yet.</p>"}</div>
  `));
});

app.get("/reception/history", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE).filter(order => order.billStatus === "Paid");
  const orderCards = orders.map(order => `
    <article class="card order-card">
      <div class="order-head">
        <h2>Table ${order.table}</h2>
        <span class="badge">Paid</span>
      </div>
      <p>${order.customerName || "Customer"} | ${order.customerPhone || "No phone"}</p>
      <p>Order #${order.id}</p>
      ${order.customerNote ? `<p class="note-box">${order.customerNote}</p>` : ""}
      <strong>${payableTotal(order)}</strong>
      <a class="button" href="/bill/${order.id}">View Bill</a>
    </article>
  `).join("");

  res.send(page("Paid Bills", `
    <nav class="topbar">
      <strong>Paid Bills</strong>
      <span>
        <a href="/reception">Reception</a>
        <a href="/reception/bookings">Reservations</a>
        <a href="/admin">Admin</a>
        <a href="/admin/reports">Reports</a>
      </span>
    </nav>
    <div class="grid">${orderCards || "<p>No paid bills yet.</p>"}</div>
  `));
});

app.get("/admin/qr", requireAdmin, (req, res) => {
  const business = settings();
  const qrCount = Number(req.query.count || 12);
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const url = `${baseUrl}/customer/login`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
  const cards = Array.from({ length: qrCount }, () => {

    return `
      <article class="qr-card">
        <h2>Scan To Order</h2>
        <img src="${qrUrl}" alt="QR code for ordering">
        <p>${business.restaurantName}</p>
        <p>Scan, sign in, reserve, and order</p>
        <small>${url}</small>
      </article>
    `;
  }).join("");

  res.send(page("Ordering QR Codes", `
    <nav class="topbar no-print">
      <strong>Ordering QR Codes</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/admin/reports">Reports</a>
        <button class="primary" onclick="window.print()">Print QR Codes</button>
      </span>
    </nav>
    <form method="GET" action="/admin/qr" class="card qr-form no-print">
      <label>Number of QR copies <input name="count" type="number" min="1" max="100" value="${qrCount}"></label>
      <button type="submit">Generate</button>
    </form>
    <section class="qr-grid">${cards}</section>
  `));
});

app.get("/admin/bookings", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const bookings = readJson(BOOKINGS_FILE)
    .sort((a, b) => `${a.date} ${a.slot}`.localeCompare(`${b.date} ${b.slot}`));

  const cards = bookings.map(booking => {
    const linkedOrder = booking.orderId ? orders.find(order => order.id === booking.orderId) : null;

    return `
      <article class="card order-card">
        <div class="order-head">
          <h2>Table ${booking.table}</h2>
          <span class="badge">${booking.status}</span>
        </div>
        <p>${formatBookingDate(booking.date)} | ${formatBookingSlot(booking.slot)}</p>
        <p>${booking.customerName || "Customer"} | ${booking.customerPhone || "No phone"}</p>
        <p>${booking.partySize || 1} people | Reservation ${money(booking.reservePrice || 0)}</p>
        <p>Reservation #${booking.id}</p>
        ${booking.note ? `<p class="note-box">${booking.note}</p>` : ""}
        ${linkedOrder ? `<p class="hint">Linked order: ${linkedOrder.id} | ${payableTotal(linkedOrder)} | ${linkedOrder.status}</p>` : "<p class='hint'>No linked food order yet.</p>"}
      </article>
    `;
  }).join("");

  res.send(page("People Reservations", `
    <nav class="topbar">
      <strong>People Reservations</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/reception">Reception</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/settings">Business Details</a>
      </span>
    </nav>
    <section class="intro">
      <h1>Reserved Seats By Slot</h1>
      <p>Review reservations, guest counts, and linked food orders in one place.</p>
    </section>
    <div class="grid">${cards || "<p>No reservations have been created yet.</p>"}</div>
  `));
});

app.get("/admin/inventory", requireAdmin, (req, res) => {
  const inventory = readJson(INVENTORY_FILE);
  const rows = inventory.map(item => `
    <tr>
      <td>${safe(item.name)}</td>
      <td>${safe(item.category || "General")}</td>
      <td>${Number(item.stock || 0)} ${safe(item.unit || "units")}</td>
      <td>${Number(item.reorderLevel || 0)} ${safe(item.unit || "units")}</td>
      <td>${money(item.costPerUnit || 0)}</td>
      <td>${safe(item.supplier || "-")}</td>
      <td>${Number(item.stock || 0) <= Number(item.reorderLevel || 0) ? "<span class='alert-text'>Restock soon</span>" : "Healthy"}</td>
      <td><a class="danger" href="/admin/inventory/delete/${item.id}">Delete</a></td>
    </tr>
  `).join("");
  const lowStock = inventory.filter(item => Number(item.stock || 0) <= Number(item.reorderLevel || 0)).length;

  res.send(page("Inventory", `
    <nav class="topbar">
      <strong>Inventory Control</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/kitchen">Kitchen</a>
        <a href="/reception">Reception</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/settings">Business Details</a>
      </span>
    </nav>
    <section class="admin-stats">
      <article class="card stat-card">
        <span>Total inventory items</span>
        <strong>${inventory.length}</strong>
      </article>
      <article class="card stat-card">
        <span>Low stock items</span>
        <strong>${lowStock}</strong>
      </article>
    </section>
    <section class="split">
      <form method="POST" action="/admin/inventory" class="card form-card">
        <h1>Add Inventory Item</h1>
        <p class="hint">Track ingredients, kitchen supplies, packaging, cleaning materials, or any other operational stock.</p>
        <label>Item Name <input name="name" required></label>
        <div class="two-col">
          <label>Category <input name="category" placeholder="Ingredients, Cleaning, Packaging"></label>
          <label>Unit <input name="unit" placeholder="kg, litres, pcs, packets"></label>
        </div>
        <div class="two-col">
          <label>Current Stock <input name="stock" type="number" min="0" step="0.01" required></label>
          <label>Reorder Level <input name="reorderLevel" type="number" min="0" step="0.01" required></label>
        </div>
        <div class="two-col">
          <label>Cost Per Unit <input name="costPerUnit" type="number" min="0" step="0.01"></label>
          <label>Supplier <input name="supplier" placeholder="Vendor name"></label>
        </div>
        <label>Notes <textarea name="notes" rows="3" placeholder="Storage location, brand, usage notes, or internal instructions"></textarea></label>
        <button class="primary" type="submit">Save Inventory Item</button>
      </form>
      <section>
        <h1>Inventory Register</h1>
        <table>
          <thead><tr><th>Item</th><th>Category</th><th>Stock</th><th>Reorder</th><th>Unit Cost</th><th>Supplier</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || "<tr><td colspan='8'>No inventory items added yet.</td></tr>"}</tbody>
        </table>
      </section>
    </section>
  `));
});

app.post("/admin/inventory", requireAdmin, (req, res) => {
  const inventory = readJson(INVENTORY_FILE);
  inventory.unshift({
    id: `INV-${Date.now()}`,
    name: String(req.body.name || "").trim(),
    category: String(req.body.category || "General").trim(),
    unit: String(req.body.unit || "units").trim(),
    stock: Math.max(0, Number(req.body.stock || 0)),
    reorderLevel: Math.max(0, Number(req.body.reorderLevel || 0)),
    costPerUnit: Math.max(0, Number(req.body.costPerUnit || 0)),
    supplier: String(req.body.supplier || "").trim(),
    notes: String(req.body.notes || "").trim(),
    updatedAt: new Date().toISOString()
  });
  writeJson(INVENTORY_FILE, inventory);
  res.redirect("/admin/inventory");
});

app.get("/admin/inventory/delete/:id", requireAdmin, (req, res) => {
  const inventory = readJson(INVENTORY_FILE).filter(item => item.id !== req.params.id);
  writeJson(INVENTORY_FILE, inventory);
  res.redirect("/admin/inventory");
});

app.get("/admin/reports", requireAdmin, (req, res) => {
  const startYear = Math.max(2020, Number(req.query.fy || currentFinancialYearStart()));
  const report = salesReportData(startYear);
  const fyOptions = Array.from({ length: 5 }, (_, index) => currentFinancialYearStart() - index)
    .map(year => `<option value="${year}" ${year === startYear ? "selected" : ""}>${financialYearLabel(year)}</option>`)
    .join("");
  const monthRows = report.months.map(month => `
    <tr>
      <td>${month.label}</td>
      <td>${month.orders}</td>
      <td>${money(month.sales)}</td>
    </tr>
  `).join("");
  const topItems = report.topItems.map(item => `
    <tr>
      <td>${safe(item.name)}</td>
      <td>${item.qty}</td>
      <td>${money(item.sales)}</td>
    </tr>
  `).join("");

  res.send(page("Reports", `
    <nav class="topbar">
      <strong>Sales & Performance Reports</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/reception">Reception</a>
        <a href="/admin/inventory">Inventory</a>
        <a href="/admin/settings">Business Details</a>
      </span>
    </nav>
    <section class="admin-stats">
      <article class="card stat-card">
        <span>${report.label} sales</span>
        <strong>${money(report.fySales)}</strong>
      </article>
      <article class="card stat-card">
        <span>${report.label} paid orders</span>
        <strong>${report.fyOrders}</strong>
      </article>
      <article class="card stat-card">
        <span>Today's sales</span>
        <strong>${money(report.todaySales)}</strong>
      </article>
      <article class="card stat-card">
        <span>Today's paid bills</span>
        <strong>${report.todayOrders}</strong>
      </article>
    </section>
    <section class="split">
      <section class="card form-card">
        <h1>Financial Year Report</h1>
        <p class="hint">Track month-wise paid sales using the Indian financial year cycle from April to March.</p>
        <form method="GET" action="/admin/reports" class="inline-filter">
          <label>
            Select Financial Year
            <select name="fy">${fyOptions}</select>
          </label>
          <button class="primary" type="submit">Load Report</button>
        </form>
        <div class="report-panel">
          <p><strong>Report period:</strong> ${report.label}</p>
          <p><strong>Today's date:</strong> ${formatDateLabel(report.today)}</p>
          <p><strong>Daily sales:</strong> ${money(report.todaySales)}</p>
        </div>
      </section>
      <section class="card form-card">
        <h1>Top Selling Items</h1>
        <table>
          <thead><tr><th>Item</th><th>Qty Sold</th><th>Sales</th></tr></thead>
          <tbody>${topItems || "<tr><td colspan='3'>No paid sales available for this financial year.</td></tr>"}</tbody>
        </table>
      </section>
    </section>
    <section class="card form-card">
      <h1>Month-wise Sales</h1>
      <table>
        <thead><tr><th>Month</th><th>Paid Bills</th><th>Sales</th></tr></thead>
        <tbody>${monthRows}</tbody>
      </table>
    </section>
  `));
});

app.get("/admin/settings", requireAdmin, (req, res) => {
  const business = settings();
  const minimumAllowedTables = highestActiveTable();
  const tableConfigFields = tableConfigs(business).map(config => `
    <div class="card">
      <h3>Table ${config.table}</h3>
      <label>Seats <input name="tableSeats_${config.table}" type="number" min="1" max="50" value="${config.seats}" required></label>
      <label>Reservation Charge <input name="tablePrice_${config.table}" type="number" min="0" step="1" value="${config.reservePrice}" required></label>
    </div>
  `).join("");

  res.send(page("Business Details", `
    <nav class="topbar">
      <strong>Business Details</strong>
      <span>
        <a href="/admin">Admin</a>
        <a href="/reception">Reception</a>
        <a href="/admin/inventory">Inventory</a>
        <a href="/admin/reports">Reports</a>
      </span>
    </nav>

    <section class="settings-layout">
      <form method="POST" action="/admin/settings" class="card form-card">
        <h1>Restaurant & Bill Settings</h1>
        <label>Restaurant Name <input name="restaurantName" value="${safe(business.restaurantName)}" required></label>
        <label>Address <textarea name="address" rows="3" required>${safe(business.address)}</textarea></label>
        <label>Phone <input name="phone" value="${safe(business.phone)}" required></label>
        <label>Email <input name="email" value="${safe(business.email)}" required></label>
        <label>GST Number <input name="gst" value="${safe(business.gst)}"></label>
        <label>FSSAI Number <input name="fssai" value="${safe(business.fssai)}"></label>
        <label>Total Tables <input name="tableCount" type="number" min="1" max="500" value="${safe(business.tableCount)}" required></label>
        <p class="hint">The admin can change the table count here. It will not save below the highest active unpaid table. Minimum allowed right now: ${minimumAllowedTables || 1}.</p>
        <div class="two-col">
          <label>Default Seats Per Table <input name="defaultSeatsPerTable" type="number" min="1" max="50" value="${safe(business.defaultSeatsPerTable || 4)}" required></label>
          <label>Late Fee After Slot + Grace <input name="lateFeeAmount" type="number" min="0" step="1" value="${safe(business.lateFeeAmount || 100)}" required></label>
        </div>
        <label>Late Fee Grace Minutes <input name="lateGraceMinutes" type="number" min="0" max="240" step="1" value="${safe(business.lateGraceMinutes || 20)}" required></label>
        <div class="two-col">
          <label>Tax Name <input name="taxName" value="${safe(business.taxName)}" required></label>
          <label>Tax Rate % <input name="taxRate" type="number" min="0" max="100" step="0.01" value="${safe(business.taxRate)}" required></label>
        </div>
        <div>
          <p class="eyebrow">Table Config</p>
          <div class="grid">${tableConfigFields}</div>
        </div>
        <label>Bill Footer Message <textarea name="serviceNote" rows="3">${safe(business.serviceNote)}</textarea></label>
        <button class="primary" type="submit">Save Business Details</button>
      </form>

      <aside class="card preview-card">
        <p class="eyebrow">Bill Preview</p>
        <h2>${safe(business.restaurantName)}</h2>
        <p>${safe(business.address)}</p>
        <p>${safe(business.phone)}</p>
        <p>${safe(business.email)}</p>
        <p>GSTIN: ${safe(business.gst)}</p>
        <p>FSSAI: ${safe(business.fssai)}</p>
        <hr>
        <p>Total Tables: ${safe(business.tableCount)}</p>
        <p>Default Seats: ${safe(business.defaultSeatsPerTable || 4)}</p>
        <p>Late Fee: ${money(business.lateFeeAmount || 100)} after ${safe(business.lateGraceMinutes || 20)} minutes</p>
        <p>${safe(business.taxName)}: ${safe(business.taxRate)}%</p>
        <p class="hint">${safe(business.serviceNote)}</p>
      </aside>
    </section>
  `));
});

app.post("/admin/settings", requireAdmin, (req, res) => {
  const minimumAllowedTables = highestActiveTable();
  const requestedTableCount = Math.max(1, Number(req.body.tableCount || 1));
  const nextTableCount = Math.max(requestedTableCount, minimumAllowedTables);
  const tableConfigsInput = Array.from({ length: nextTableCount }, (_, index) => {
    const table = index + 1;
    return {
      table,
      seats: Math.max(1, Number(req.body[`tableSeats_${table}`] || req.body.defaultSeatsPerTable || 4)),
      reservePrice: Math.max(0, Number(req.body[`tablePrice_${table}`] || 0))
    };
  });
  const nextSettings = {
    restaurantName: String(req.body.restaurantName || DEFAULT_SETTINGS.restaurantName).trim(),
    address: String(req.body.address || "").trim(),
    phone: String(req.body.phone || "").trim(),
    email: String(req.body.email || "").trim(),
    gst: String(req.body.gst || "").trim(),
    fssai: String(req.body.fssai || "").trim(),
    tableCount: nextTableCount,
    defaultSeatsPerTable: Math.max(1, Number(req.body.defaultSeatsPerTable || 4)),
    lateFeeAmount: Math.max(0, Number(req.body.lateFeeAmount || 100)),
    lateGraceMinutes: Math.max(0, Number(req.body.lateGraceMinutes || 20)),
    tableConfigs: tableConfigsInput,
    taxName: String(req.body.taxName || "Tax").trim(),
    taxRate: Math.max(0, Number(req.body.taxRate || 0)),
    serviceNote: String(req.body.serviceNote || "").trim()
  };

  writeJson(SETTINGS_FILE, nextSettings);
  res.redirect("/admin/settings");
});

app.post("/admin/tables", requireAdmin, (req, res) => {
  const business = settings();
  const minimumAllowedTables = highestActiveTable();
  const requestedTableCount = Math.max(1, Number(req.body.tableCount || business.tableCount || 1));
  const nextSettings = {
    ...business,
    tableCount: Math.max(requestedTableCount, minimumAllowedTables)
  };

  writeJson(SETTINGS_FILE, nextSettings);
  res.redirect("/admin");
});

app.get("/bill/:id", requireAdmin, (req, res) => {
  const business = settings();
  const order = readJson(ORDERS_FILE).find(item => item.id === req.params.id);
  if (!order) return res.status(404).send(page("Bill Missing", "<h1>Order not found</h1>"));
  const amount = billAmounts(order, business);

  const items = order.items.map(item => `
    <tr>
      <td>${item.name}</td>
      <td>${item.qty}</td>
      <td>${money(item.price)}</td>
      <td>${money(item.price * item.qty)}</td>
    </tr>
  `).join("");

  res.send(page("Bill", `
    <section class="bill">
      <div class="bill-head">
        <div>
          <p class="eyebrow">Tax Invoice</p>
          <h1>${safe(business.restaurantName)}</h1>
          <p>${safe(business.address)}</p>
          <p>${safe(business.phone)} | ${safe(business.email)}</p>
          <p>GSTIN: ${safe(business.gst)} | FSSAI: ${safe(business.fssai)}</p>
        </div>
        <button class="primary no-print" onclick="window.print()">Print Bill</button>
      </div>
      ${billDetailsHtml(order)}
      ${order.customerNote ? `<p class="note-box"><strong>Customer note:</strong> ${order.customerNote}</p>` : ""}
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <div class="bill-total-box">
        <p>Food Subtotal <strong>${money(amount.subtotal)}</strong></p>
        <p>${safe(business.taxName)} (${amount.taxRate}%) <strong>${money(amount.taxAmount)}</strong></p>
        ${amount.reserveCharge ? `<p>Reservation Charge <strong>${money(amount.reserveCharge)}</strong></p>` : ""}
        ${amount.lateFee ? `<p>Late Payment Fee <strong>${money(amount.lateFee)}</strong></p>` : ""}
        <h2>Grand Total: ${money(amount.grandTotal)}</h2>
      </div>
      <p class="bill-footer">${safe(business.serviceNote)}</p>
      <div class="actions no-print">
        <a class="button" href="/bill/${order.id}/pdf">Download PDF</a>
        <a class="button" href="/reception">Back to Reception</a>
      </div>
    </section>
  `));
});

app.get("/bill/:id/pdf", requireAdmin, (req, res) => {
  const order = readJson(ORDERS_FILE).find(item => item.id === req.params.id);
  if (!order) return res.status(404).send("Order not found");

  const fileName = `bill-${order.id}.pdf`;
  const filePath = path.join(BILLS_DIR, fileName);
  createSimplePdf(filePath, billText(order));
  res.download(filePath, fileName);
});

app.get("/customer/bill/:id/pdf", requireCustomer, (req, res) => {
  const order = readJson(ORDERS_FILE).find(item => item.id === req.params.id);

  if (!canCustomerDownloadBill(req, order)) {
    return res.status(403).send(page("Bill Not Ready", `
      <h1>Bill not ready yet</h1>
      <p>The download option will appear after reception marks the bill as paid.</p>
      <a class="button" href="/customer">Back to orders</a>
    `));
  }

  const fileName = `bill-${order.id}.pdf`;
  const filePath = path.join(BILLS_DIR, fileName);
  createSimplePdf(filePath, billText(order));
  res.download(filePath, fileName);
});

app.post("/bill/:id/send", requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const order = orders.find(item => item.id === req.params.id);
  if (!order) return res.status(404).send("Order not found");

  const fileName = `bill-${order.id}.pdf`;
  const filePath = path.join(BILLS_DIR, fileName);
  createSimplePdf(filePath, billText(order));

  order.billPdf = `/bills/${fileName}`;
  order.billSentAt = new Date().toISOString();
  order.billSendNote = "PDF generated locally. Connect an SMS or WhatsApp API to deliver it to the customer phone.";
  writeJson(ORDERS_FILE, orders);

  res.redirect("/reception");
});

app.post("/bill/:id/paid", requireAdmin, (req, res) => {
  const business = settings();
  const bookings = readJson(BOOKINGS_FILE);
  const orders = readJson(ORDERS_FILE);
  const order = orders.find(item => item.id === req.params.id);

  if (order) {
    const amount = billAmounts(order, business);
    order.subtotal = amount.subtotal;
    order.taxRate = amount.taxRate;
    order.taxAmount = amount.taxAmount;
    order.bookingCharge = amount.reserveCharge;
    order.lateFee = amount.lateFee;
    order.total = amount.grandTotal;
    order.billStatus = "Paid";
    order.paidAt = new Date().toISOString();
    writeJson(ORDERS_FILE, orders);

    const booking = bookingForOrder(order, bookings);
    if (booking) {
      booking.status = "Completed";
      booking.paidAt = order.paidAt;
      writeJson(BOOKINGS_FILE, bookings);
    }
  }

  res.redirect("/reception");
});

app.post("/kitchen/:id/status", requireAdmin, (req, res) => {
  const allowed = ["Pending", "Preparing", "Ready", "Served"];
  const orders = readJson(ORDERS_FILE);
  const order = orders.find(item => item.id === req.params.id);

  if (order && allowed.includes(req.body.status)) {
    order.status = req.body.status;
    order.updatedAt = new Date().toISOString();
    writeJson(ORDERS_FILE, orders);
  }

  res.redirect("/kitchen");
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/login", (req, res) => {
  if (req.body.username === "admin" && req.body.password === "1234") {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }

  res.send(page("Login Failed", `
    <h1>Wrong username or password</h1>
    <a class="button" href="/login">Try again</a>
  `));
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/customer/logout", (req, res) => {
  delete req.session.customerPhone;
  delete req.session.customerName;
  delete req.session.activeBookingId;
  delete req.session.currentTable;
  req.session.cart = [];
  res.redirect("/");
});

app.get("/admin", requireAdmin, (req, res) => {
  const menu = readJson(MENU_FILE);
  const orders = readJson(ORDERS_FILE);
  const inventory = readJson(INVENTORY_FILE);
  const business = settings();
  const occupied = occupiedTables(orders);
  const freeTables = availableTables(business, orders);
  const minimumAllowedTables = highestActiveTable(orders);
  const liveOrders = orders.filter(order => order.status !== "Served").length;
  const billingOrders = orders.filter(order => order.billStatus !== "Paid").length;
  const paidOrders = orders.filter(order => order.billStatus === "Paid").length;
  const lowStock = inventory.filter(item => Number(item.stock || 0) <= Number(item.reorderLevel || 0)).length;
  const report = salesReportData();
  const rows = menu.map((item, index) => `
    <tr>
      <td><img class="thumb" src="${item.image}" alt="${item.name}"></td>
      <td>${item.name}</td>
      <td>${money(item.price)}</td>
      <td><a class="danger" href="/delete/${index}">Delete</a></td>
    </tr>
  `).join("");

  res.send(page("Admin Panel", `
    <nav class="topbar">
      <strong>Operations Dashboard</strong>
      <span>
        <a href="/">Home</a>
        <a href="/kitchen">Kitchen</a>
        <a href="/reception">Reception</a>
        <a href="/admin/bookings">Bookings</a>
        <a href="/admin/inventory">Inventory</a>
        <a href="/admin/reports">Reports</a>
        <a href="/admin/qr">Ordering QR</a>
        <a href="/admin/settings">Business Details</a>
        <a href="/logout">Logout</a>
      </span>
    </nav>

    <section class="intro">
      <h1>Restaurant command center</h1>
      <p>Monitor service, guide guests smoothly, manage stock, and review sales from one dashboard.</p>
    </section>

    <section class="admin-stats">
      <a class="card stat-card" href="/kitchen">
        <span>Live Orders</span>
        <strong>${liveOrders}</strong>
      </a>
      <a class="card stat-card" href="/reception">
        <span>Reception Queue</span>
        <strong>${billingOrders}</strong>
      </a>
      <a class="card stat-card" href="/reception/history">
        <span>Paid Bills</span>
        <strong>${paidOrders}</strong>
      </a>
      <a class="card stat-card" href="/admin/bookings">
        <span>Reservations</span>
        <strong>${readJson(BOOKINGS_FILE).filter(booking => booking.status !== "Cancelled").length}</strong>
      </a>
      <a class="card stat-card" href="/admin/inventory">
        <span>Low Stock Alerts</span>
        <strong>${lowStock}</strong>
      </a>
      <a class="card stat-card" href="/admin/reports">
        <span>Today's Sales</span>
        <strong>${money(report.todaySales)}</strong>
      </a>
    </section>

    <section class="guide-grid">
      <article class="card guide-card">
        <p class="eyebrow">Service flow</p>
        <h3>Guide every customer clearly</h3>
      <p>The customer experience now covers sign-in, reservations, ordering, cart review, and bill access in clear English.</p>
      </article>
      <article class="card guide-card">
        <p class="eyebrow">Table operations</p>
        <h3>Watch occupancy live</h3>
        <p>${occupied.size} tables are occupied and ${freeTables.length} tables are free right now.</p>
      </article>
      <article class="card guide-card">
        <p class="eyebrow">Business insight</p>
        <h3>Keep stock and sales under control</h3>
        <p>Use inventory tracking and financial-year reporting to stay ready for service.</p>
      </article>
    </section>

    <section class="split">
      <div class="form-card">
        <form method="POST" action="/add-item" enctype="multipart/form-data" class="card form-card">
          <h1>Add Menu Item</h1>
          <label>Item Name <input name="name" required></label>
          <label>Price <input name="price" type="number" min="1" required></label>
          <label>Food Image <input name="image" type="file" accept="image/*"></label>
          <button class="primary" type="submit">Add Item</button>
        </form>

        <form method="POST" action="/admin/tables" class="card form-card">
          <h1>Manage Tables</h1>
          <p class="hint">Update your total service tables here. The system will protect the minimum safe count required by current unpaid orders.</p>
          <label>Total Tables <input name="tableCount" type="number" min="1" max="500" value="${business.tableCount}" required></label>
          <div class="two-col">
            <div class="card">
              <span class="hint">Occupied</span>
              <strong>${occupied.size}</strong>
            </div>
            <div class="card">
              <span class="hint">Available</span>
              <strong>${freeTables.length}</strong>
            </div>
          </div>
          <p class="hint">The minimum safe table count right now is ${minimumAllowedTables || 1}.</p>
          <button class="primary" type="submit">Update Table Count</button>
        </form>
      </div>

      <section>
        <h1>Current Menu</h1>
        <table>
          <thead><tr><th>Image</th><th>Name</th><th>Price</th><th></th></tr></thead>
          <tbody>${rows || "<tr><td colspan='4'>No items yet.</td></tr>"}</tbody>
        </table>
      </section>
    </section>
  `));
});

app.post("/add-item", requireAdmin, upload.single("image"), (req, res) => {
  const menu = readJson(MENU_FILE);
  const image = req.file ? `/uploads/${req.file.filename}` : "/placeholder-food.svg";

  menu.push({
    name: req.body.name.trim(),
    price: Number(req.body.price),
    image
  });

  writeJson(MENU_FILE, menu);
  res.redirect("/admin");
});

app.get("/delete/:index", requireAdmin, (req, res) => {
  const menu = readJson(MENU_FILE);
  const index = Number(req.params.index);

  if (Number.isInteger(index) && index >= 0 && index < menu.length) {
    menu.splice(index, 1);
    writeJson(MENU_FILE, menu);
  }

  res.redirect("/admin");
});

app.listen(PORT, () => {
  console.log(`Running http://localhost:${PORT}`);
});
