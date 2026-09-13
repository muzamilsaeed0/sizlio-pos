"use strict";

/* =====================================================
   INVENTORY MODULE
   Production-ready frontend inventory management
===================================================== */

const token = localStorage.getItem("token");

let editingId = null;
let inventoryItems = [];

let currentFilter = "all";
let currentSort = "name-asc";
let showInactiveItems = false;

let inventoryControlsInitialized = false;

let stockTransactionId = null;
let stockTransactionType = null;
let stockTransactionUnit = null;
let stockTransactionCurrentStock = 0;


/* =====================================================
   API HELPER
===================================================== */

async function apiRequest(url, options = {}) {

  const headers = {
    ...(options.body
      ? { "Content-Type": "application/json" }
      : {}),
    ...(token
      ? { "Authorization": `Bearer ${token}` }
      : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  let data = {};

  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
      `Request failed with status ${response.status}`
    );
  }

  return data;
}


/* =====================================================
   THEME
===================================================== */

function toggleTheme() {

  const dark =
    !document.body.classList.contains("dark-theme");

  document.body.classList.toggle(
    "dark-theme",
    dark
  );

  localStorage.setItem(
    "theme",
    dark ? "dark" : "light"
  );

  updateThemeButtonLabel(dark);
}

function updateThemeButtonLabel(isDark) {

  const button =
    document.getElementById("theme-toggle-btn");

  if (!button) {
    return;
  }

  button.innerText =
    isDark
      ? "☀️ Light Mode"
      : "🌙 Dark Mode";
}

function initializeTheme() {

  const isDark =
    localStorage.getItem("theme") === "dark";

  document.body.classList.toggle(
    "dark-theme",
    isDark
  );

  updateThemeButtonLabel(isDark);
}


/* =====================================================
   SAVE / UPDATE INVENTORY ITEM - FIXED
===================================================== */

async function saveItem() {

  const name =
    document.getElementById("name")?.value.trim();

  const category =
    document.getElementById("category")?.value.trim();

  const unit =
    document.getElementById("unit")?.value.trim();

  const packageSizeRaw =
    document.getElementById("package_size")?.value;

  const packageUnit =
    document.getElementById("package_unit")?.value.trim();

  const package_size =
    packageSizeRaw !== undefined &&
    packageSizeRaw !== null &&
    String(packageSizeRaw).trim() !== ""
      ? Number(packageSizeRaw)
      : null;

  // FIX: Use parseFloat directly, NOT parseSmartQuantity for stock_quantity
  // parseSmartQuantity is only for stock transaction modal
  const stockQuantityRaw =
    document.getElementById("stock_quantity")?.value;

  const stock_quantity =
    stockQuantityRaw !== undefined &&
    stockQuantityRaw !== null &&
    String(stockQuantityRaw).trim() !== ""
      ? Number(stockQuantityRaw)
      : 0;

  const minimum_stock =
    Number(
      document.getElementById("minimum_stock")?.value
    );

  const purchase_price =
    Number(
      document.getElementById("purchase_price")?.value
    );

  const supplier =
    document.getElementById("supplier")?.value.trim();

  // Validation
  if (
    !name ||
    !category ||
    !unit ||
    !Number.isFinite(stock_quantity) ||
    stock_quantity < 0 ||
    !Number.isFinite(minimum_stock) ||
    minimum_stock < 0 ||
    !Number.isFinite(purchase_price) ||
    purchase_price <= 0 ||
    (
      package_size !== null &&
      (
        !Number.isFinite(package_size) ||
        package_size <= 0 ||
        !packageUnit
      )
    )
  ) {
    alert("Please fill all required fields correctly.");
    return;
  }

  const body = {
    name,
    category,
    unit,
    package_size,
    package_unit: package_size !== null ? packageUnit : null,
    stock_quantity,
    minimum_stock,
    purchase_price,
    supplier
  };

  // FIX: Clear editingId after save to prevent double submission
  const isEditing = Boolean(editingId);

  // FIX: If editing, use the ID from editingId, don't create new
  const url = isEditing
    ? `/api/inventory/${editingId}`
    : "/api/inventory";

  const method = isEditing ? "PUT" : "POST";

  const saveButton = document.getElementById("save-btn");

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.innerText = isEditing ? "Updating..." : "Saving...";
  }

  try {

    const data = await apiRequest(url, { method, body: JSON.stringify(body) });

    if (!data.success) {
      alert(data.message || "Unable to save inventory item.");
      return;
    }

    alert(
      data.message ||
      (isEditing
        ? "Inventory item updated successfully."
        : "Inventory item added successfully.")
    );

    // FIX: Reset form AFTER successful save
    clearInventoryForm();
    
    // FIX: Reset editingId AFTER save to prevent double submission
    const savedId = editingId;
    editingId = null;
    setEditMode(false);

    await refreshInventoryData();

  } catch (error) {
    console.error("saveItem:", error);
    alert(error.message || "Something went wrong while saving the item.");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.innerText = editingId ? "🔄 Update Item" : "💾 Save Item";
    }
  }
}



/* =====================================================
   CLEAR FORM
===================================================== */

function backToManager() {
    history.back();
}

async function loadBranding() {
  try {
    const res = await fetch('/api/restaurants/me', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    if (data.success) {
      const header = document.getElementById('brand-header');
      header.style.display = 'flex';
      header.innerHTML = (data.data.logo_url ? `<img src="${data.data.logo_url}">` : '') +
        `<span class="brand-name">${data.data.name}</span>`;
    }
  } catch (e) { console.error('branding load failed', e); }
}


/* =====================================================
   CLEAR INVENTORY FORM - FIXED
===================================================== */

function clearInventoryForm() {
  const fields = [
    "name",
    "category",
    "unit",
    "package_size",
    "package_unit",
    "stock_quantity",
    "minimum_stock",
    "purchase_price",
    "supplier"
  ];

  fields.forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.value = "";
    }
  });

  // Also clear bulk calculator fields
  const bulkQty = document.getElementById('bulk-qty');
  const bulkUnit = document.getElementById('bulk-unit');
  const bulkTotalPrice = document.getElementById('bulk-total-price');

  if (bulkQty) bulkQty.value = "";
  if (bulkUnit) bulkUnit.value = "1000";
  if (bulkTotalPrice) bulkTotalPrice.value = "";

  const title = document.getElementById("inventory-form-title");
  if (title) {
    title.innerText = "➕ Add Inventory Item";
  }
}


/* =====================================================
   EDIT ITEM - FIXED
===================================================== */

function editItem(item) {
  if (!item) {
    return;
  }

  // FIX: Always reset form first before editing
  clearInventoryForm();

  editingId = Number(item.id);

  const name = document.getElementById("name");
  const category = document.getElementById("category");
  const unit = document.getElementById("unit");
  const packageSize = document.getElementById("package_size");
  const packageUnit = document.getElementById("package_unit");
  const stock = document.getElementById("stock_quantity");
  const minimum = document.getElementById("minimum_stock");
  const price = document.getElementById("purchase_price");
  const supplier = document.getElementById("supplier");

  if (name) name.value = item.name || "";
  if (category) category.value = item.category || "";
  if (unit) unit.value = item.unit || "";
  if (packageSize) packageSize.value = item.package_size ?? "";
  if (packageUnit) packageUnit.value = item.package_unit || "";
  if (stock) stock.value = item.stock_quantity ?? "";
  if (minimum) minimum.value = item.minimum_stock ?? "";
  if (price) price.value = item.purchase_price ?? "";
  if (supplier) supplier.value = item.supplier || "";

  // FIX: Set edit mode AFTER filling values
  setEditMode(true);

  const form = document.getElementById("inventory-form");
  if (form) {
    form.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}


/* =====================================================
   CANCEL EDIT - FIXED
===================================================== */

function cancelEdit() {
  // FIX: Reset everything
  editingId = null;
  clearInventoryForm();
  setEditMode(false);
  
  // Also reset any pending state
  const saveButton = document.getElementById("save-btn");
  if (saveButton) {
    saveButton.disabled = false;
    saveButton.innerText = "💾 Save Item";
  }
}
/* =====================================================
   LOAD INVENTORY
===================================================== */

async function loadItems() {

  await loadBranding();
  showInventoryLoading();

  try {

    const data =
      await apiRequest(
        "/api/inventory?status=all"
      );


    if (!data.success) {

      showInventoryError(
        data.message ||
        "Unable to load inventory."
      );

      return;
    }


    inventoryItems =
      Array.isArray(data.data)
        ? data.data
        : [];


    renderInventory();

  } catch (error) {

    console.error(
      "loadItems:",
      error
    );

    showInventoryError(
      error.message ||
      "Unable to connect to the server."
    );
  }
}


/* =====================================================
   REFRESH
===================================================== */

async function refreshInventoryData() {

  await loadItems();

  await loadDashboard();
}


/* =====================================================
   ACTIVE STATUS
===================================================== */

function isItemActive(item) {

  if (
    item.is_active !== undefined &&
    item.is_active !== null
  ) {

    const value =
      item.is_active;

    if (
      value === true ||
      value === 1 ||
      value === "1" ||
      value === "true"
    ) {
      return true;
    }

    if (
      value === false ||
      value === 0 ||
      value === "0" ||
      value === "false"
    ) {
      return false;
    }
  }


  if (
    item.active !== undefined &&
    item.active !== null
  ) {

    const value =
      item.active;

    if (
      value === true ||
      value === 1 ||
      value === "1" ||
      value === "true"
    ) {
      return true;
    }

    if (
      value === false ||
      value === 0 ||
      value === "0" ||
      value === "false"
    ) {
      return false;
    }
  }


  if (
    item.status !== undefined &&
    item.status !== null
  ) {

    const status =
      String(
        item.status
      ).toLowerCase()
      .trim();

    return (
      status === "active" ||
      status === "1" ||
      status === "true"
    );
  }


  return true;
}


/* =====================================================
   KITCHEN-REQUEST TRANSACTION FILTER
   Kitchen request approvals still deduct from the
   actual stock quantity on the backend — this filter
   only hides those specific transaction rows from the
   Dashboard "Recent Transactions" list and the item
   "History" modal, per business requirement.
===================================================== */

function isKitchenRequestTransaction(transaction) {

  if (!transaction) {
    return false;
  }

  const note =
    String(
      transaction.note || ""
    ).toLowerCase();

  /*
    ONLY hide customer-order fulfillment entries,
    which always carry this exact note format:
    "Order #269 served".
    Everything else — kitchen stock transfers,
    manual stock in/out, returns — must stay visible.
  */

  if (/order\s*#\s*\d+\s*served/i.test(note)) {
    return true;
  }

  return false;
}


function filterOutKitchenTransactions(transactions) {

  if (!Array.isArray(transactions)) {
    return [];
  }

  return transactions.filter(
    transaction => !isKitchenRequestTransaction(transaction)
  );
}


/* =====================================================
   FILTER / SEARCH / SORT
===================================================== */

function renderInventory() {

  const searchInput =
    document.getElementById(
      "inventory-search"
    );


  const search =
    searchInput
      ? searchInput.value
          .trim()
          .toLowerCase()
      : "";


  let filteredItems =
    [...inventoryItems];


  /*
    IMPORTANT:
    If user selected Inactive filter,
    inactive items must ALWAYS be visible.
  */

  if (
    currentFilter !== "inactive" &&
    !showInactiveItems
  ) {

    filteredItems =
      filteredItems.filter(
        item => isItemActive(item)
      );
  }


  /* SEARCH */

  if (search) {

    filteredItems =
      filteredItems.filter(item => {

        const name =
          String(
            item.name || ""
          ).toLowerCase();

        const category =
          String(
            item.category || ""
          ).toLowerCase();

        const supplier =
          String(
            item.supplier || ""
          ).toLowerCase();

        const unit =
          String(
            item.unit || ""
          ).toLowerCase();


        return (
          name.includes(search) ||
          category.includes(search) ||
          supplier.includes(search) ||
          unit.includes(search)
        );
      });
  }


  /* FILTER */

  if (
    currentFilter === "low"
  ) {

    filteredItems =
      filteredItems.filter(item => {

        if (!isItemActive(item)) {
          return false;
        }

        return (
          Number(
            item.stock_quantity || 0
          ) <=
          Number(
            item.minimum_stock || 0
          )
        );
      });
  }


  if (
    currentFilter === "healthy"
  ) {

    filteredItems =
      filteredItems.filter(item => {

        if (!isItemActive(item)) {
          return false;
        }

        return (
          Number(
            item.stock_quantity || 0
          ) >
          Number(
            item.minimum_stock || 0
          )
        );
      });
  }


  if (
    currentFilter === "inactive"
  ) {

    filteredItems =
      filteredItems.filter(
        item => !isItemActive(item)
      );
  }


  filteredItems.sort(
    sortInventoryItems
  );


  renderInventoryCards(
    filteredItems
  );


  updateInventoryResultCount(
    filteredItems.length
  );

  updateInventoryTotalStock();
}


/* =====================================================
   SORT
===================================================== */

function sortInventoryItems(a, b) {

  switch (currentSort) {

    case "name-asc":

      return String(
        a.name || ""
      ).localeCompare(
        String(
          b.name || ""
        ),
        undefined,
        {
          sensitivity: "base"
        }
      );


    case "name-desc":

      return String(
        b.name || ""
      ).localeCompare(
        String(
          a.name || ""
        ),
        undefined,
        {
          sensitivity: "base"
        }
      );


    case "stock-desc":

      return (
        Number(
          b.stock_quantity || 0
        ) -
        Number(
          a.stock_quantity || 0
        )
      );


    case "stock-asc":

      return (
        Number(
          a.stock_quantity || 0
        ) -
        Number(
          b.stock_quantity || 0
        )
      );


    case "price-desc":

      return (
        Number(
          b.purchase_price || 0
        ) -
        Number(
          a.purchase_price || 0
        )
      );


    case "price-asc":

      return (
        Number(
          a.purchase_price || 0
        ) -
        Number(
          b.purchase_price || 0
        )
      );


    case "updated-desc":

      return (
        getUpdatedTime(b) -
        getUpdatedTime(a)
      );


    default:

      return 0;
  }
}


/* =====================================================
   UPDATED TIME
===================================================== */

function getUpdatedTime(item) {

  const dateValue =
    item.updated_at ||
    item.updatedAt ||
    item.created_at ||
    item.createdAt;


  if (!dateValue) {
    return 0;
  }


  const time =
    new Date(
      dateValue
    ).getTime();


  return Number.isFinite(time)
    ? time
    : 0;
}


/* =====================================================
   INVENTORY CARD RENDER
===================================================== */

function renderInventoryCards(items) {

  const list =
    document.getElementById(
      "inventory-list"
    );


  if (!list) {
    return;
  }


  if (!items.length) {

    let message = `
      <div class="inventory-state">

        <div class="inventory-state-icon">
          🔎
        </div>

        <div class="inventory-state-title">
          No matching items
        </div>

        <div class="inventory-state-text">
          Try another search, filter or inventory status.
        </div>

      </div>
    `;


    if (
      currentFilter === "inactive" &&
      inventoryItems.some(
        item => !isItemActive(item)
      ) === false
    ) {

      message = `
        <div class="inventory-state">

          <div class="inventory-state-icon">
            ♻️
          </div>

          <div class="inventory-state-title">
            No inactive items
          </div>

          <div class="inventory-state-text">
            Deactivated inventory items will appear here.
          </div>

        </div>
      `;
    }


    list.innerHTML =
      message;

    return;
  }


  list.innerHTML =
    items.map(item => {

      const active =
        isItemActive(item);


      const stock =
        Number(
          item.stock_quantity || 0
        );


      const minimum =
        Number(
          item.minimum_stock || 0
        );


      const isLow =
        active &&
        stock <= minimum;


      const stockValue =
        stock *
        Number(
          item.purchase_price || 0
        );


      return `

        <div
          class="
            inventory-card
            ${isLow ? "low-stock" : ""}
            ${!active ? "inactive-item" : ""}
          "
          data-id="${Number(item.id)}">


          <div class="inventory-card-top">

            <div>

              <div class="item-name">
                ${escapeHtml(item.name)}
              </div>

              <div class="item-meta">
                ${escapeHtml(
                  item.category ||
                  "Uncategorized"
                )}
              </div>

            </div>


            <span
              class="
                inventory-status
                ${active
                  ? "status-active"
                  : "status-inactive"}
              ">

              ${active
                ? "● Active"
                : "● Inactive"}

            </span>

          </div>


          <div
            class="
              inventory-stock-banner
              ${isLow
                ? "inventory-stock-low"
                : "inventory-stock-good"}
            ">

            <div>

              <div class="inventory-stock-label">
                Current Stock
              </div>

              <div class="inventory-stock-value">

                ${formatNumber(stock)}

                ${escapeHtml(
                  item.unit || ""
                )}

              </div>

            </div>


            <div class="inventory-stock-side">

              ${
                !active
                  ? "⚪ Inactive"
                  : isLow
                    ? "🔴 Low Stock"
                    : "🟢 Healthy"
              }

            </div>

          </div>


          <div class="row">

            <span>
              Minimum
            </span>

            <span>

              ${formatNumber(minimum)}

              ${escapeHtml(
                item.unit || ""
              )}

            </span>

          </div>


          <div class="row">

            <span>
              Purchase Price
            </span>

            <span>
              Rs ${formatMoney(
                item.purchase_price
              )}
            </span>

          </div>


          <div class="row">

            <span>
              Stock Value
            </span>

            <span>
              Rs ${formatMoney(stockValue)}
            </span>

          </div>


          <div class="row">

            <span>
              Supplier
            </span>

            <span>
              ${
                item.supplier
                  ? escapeHtml(
                      item.supplier
                    )
                  : "-"
              }
            </span>

          </div>


          <div class="row">

            <span>
              Package
            </span>

            <span>
              ${
                item.package_size !== null &&
                item.package_size !== undefined &&
                Number(item.package_size) > 0 &&
                item.package_unit
                  ? `${formatNumber(item.package_size)} ${escapeHtml(item.package_unit)}`
                  : "-"
              }
            </span>

          </div>


          <div class="actions">

            <button
              type="button"
              class="edit-btn"
              data-action="edit"
              data-id="${Number(item.id)}">

              ✏️ Edit

            </button>


            ${
              active
                ? `

                  <button
                    type="button"
                    class="stock-in-btn"
                    data-action="stock-in"
                    data-id="${Number(item.id)}">

                    📥 Stock In

                  </button>


                  <button
                    type="button"
                    class="stock-out-btn"
                    data-action="stock-out"
                    data-id="${Number(item.id)}">

                    📤 Stock Out

                  </button>

                `
                : ""
            }


            <button
              type="button"
              class="history-btn"
              data-action="history"
              data-id="${Number(item.id)}">

              📋 History

            </button>


            ${
              active
                ? `

                  <button
                    type="button"
                    class="delete-btn"
                    data-action="deactivate"
                    data-id="${Number(item.id)}">

                    🚫 Deactivate

                  </button>

                `
                : `

                  <button
                    type="button"
                    class="activate-btn"
                    data-action="activate"
                    data-id="${Number(item.id)}">

                    ♻️ Activate

                  </button>

                `
            }

          </div>

        </div>

      `;
    }).join("");
}


/* =====================================================
   RESULT COUNT
===================================================== */

function updateInventoryResultCount(count) {

  const element =
    document.getElementById(
      "inventory-result-count"
    );


  if (!element) {
    return;
  }


  const activeCount =
    inventoryItems.filter(
      item => isItemActive(item)
    ).length;


  const inactiveCount =
    inventoryItems.length -
    activeCount;


  element.innerText =
    `${count} shown • ${activeCount} active • ${inactiveCount} inactive`;
}


/* =====================================================
   INVENTORY CONTROLS
===================================================== */

function initializeInventoryControls() {

  if (inventoryControlsInitialized) {
    return;
  }


  inventoryControlsInitialized = true;


  const search =
    document.getElementById(
      "inventory-search"
    );


  const sort =
    document.getElementById(
      "inventory-sort"
    );


  const inactiveCheckbox =
    document.getElementById(
      "show-inactive"
    );


  if (search) {

    search.addEventListener(
      "input",
      renderInventory
    );
  }


  if (sort) {

    sort.addEventListener(
      "change",
      function() {

        currentSort =
          this.value;

        renderInventory();
      }
    );
  }


  if (inactiveCheckbox) {

    inactiveCheckbox.addEventListener(
      "change",
      function() {

        showInactiveItems =
          this.checked;

        renderInventory();
      }
    );
  }


  document
    .querySelectorAll(
      ".filter-btn"
    )
    .forEach(button => {

      button.addEventListener(
        "click",
        function() {

          document
            .querySelectorAll(
              ".filter-btn"
            )
            .forEach(btn => {

              btn.classList.remove(
                "active"
              );
            });


          this.classList.add(
            "active"
          );


          currentFilter =
            this.dataset.filter ||
            "all";


          /*
            When Inactive filter is selected,
            automatically enable inactive visibility.
          */

          if (
            currentFilter === "inactive"
          ) {

            showInactiveItems =
              true;

            if (inactiveCheckbox) {
              inactiveCheckbox.checked =
                true;
            }

          }


          renderInventory();
        }
      );
    });


  const list =
    document.getElementById(
      "inventory-list"
    );


  if (list) {

    list.addEventListener(
      "click",
      handleInventoryAction
    );
  }
}


/* =====================================================
   INVENTORY ACTION DELEGATION
===================================================== */

async function handleInventoryAction(event) {

  const button =
    event.target.closest(
      "[data-action]"
    );


  if (!button) {
    return;
  }


  const action =
    button.dataset.action;


  const id =
    Number(
      button.dataset.id
    );


  if (!id) {
    return;
  }


  const item =
    inventoryItems.find(
      inventoryItem =>
        Number(
          inventoryItem.id
        ) === id
    );


  if (!item) {

    alert(
      "Inventory item not found."
    );

    return;
  }


  switch (action) {

    case "edit":

      editItem(item);

      break;


    case "stock-in":

      await stockIn(id);

      break;


    case "stock-out":

      await stockOut(id);

      break;


    case "history":

      await showHistory(
        id,
        item.name
      );

      break;


    case "deactivate":

      await deactivateItem(id);

      break;


    case "activate":

      await activateItem(id);

      break;
  }
}


/* =====================================================
   DEACTIVATE
===================================================== */

async function deactivateItem(id) {

  const item =
    inventoryItems.find(
      inventoryItem =>
        Number(
          inventoryItem.id
        ) === Number(id)
    );


  const itemName =
    item
      ? item.name
      : "this item";


  const ok =
    confirm(
      `Deactivate "${itemName}"?\n\nThe item will remain in inventory history and can be activated again later.`
    );


  if (!ok) {
    return;
  }


  try {

    const data =
      await apiRequest(
        `/api/inventory/${id}/deactivate`,
        {
          method: "PATCH"
        }
      );


    if (!data.success) {

      alert(
        data.message ||
        "Unable to deactivate item."
      );

      return;
    }


    alert(
      data.message ||
      "Inventory item deactivated."
    );


    /*
      Automatically switch to inactive view
      so user can immediately see where item went.
    */

    showInactiveItems = true;

    currentFilter = "inactive";


    const checkbox =
      document.getElementById(
        "show-inactive"
      );


    if (checkbox) {
      checkbox.checked = true;
    }


    document
      .querySelectorAll(
        ".filter-btn"
      )
      .forEach(btn => {

        btn.classList.toggle(
          "active",
          btn.dataset.filter === "inactive"
        );
      });


    await refreshInventoryData();

  } catch (error) {

    console.error(
      "deactivateItem:",
      error
    );

    alert(
      error.message ||
      "Something went wrong while deactivating the item."
    );
  }
}


/* =====================================================
   ACTIVATE
===================================================== */

async function activateItem(id) {

  const item =
    inventoryItems.find(
      inventoryItem =>
        Number(
          inventoryItem.id
        ) === Number(id)
    );


  const itemName =
    item
      ? item.name
      : "this item";


  const ok =
    confirm(
      `Activate "${itemName}" again?`
    );


  if (!ok) {
    return;
  }


  try {

    const data =
      await apiRequest(
        `/api/inventory/${id}/activate`,
        {
          method: "PATCH"
        }
      );


    if (!data.success) {

      alert(
        data.message ||
        "Unable to activate item."
      );

      return;
    }


    alert(
      data.message ||
      "Inventory item activated successfully."
    );


    /*
      Return to normal active inventory.
    */

    currentFilter = "all";

    showInactiveItems = false;


    const checkbox =
      document.getElementById(
        "show-inactive"
      );


    if (checkbox) {
      checkbox.checked = false;
    }


    document
      .querySelectorAll(
        ".filter-btn"
      )
      .forEach(btn => {

        btn.classList.toggle(
          "active",
          btn.dataset.filter === "all"
        );
      });


    await refreshInventoryData();

  } catch (error) {

    console.error(
      "activateItem:",
      error
    );

    alert(
      error.message ||
      "Unable to activate inventory item."
    );
  }
}


/* =====================================================
   EDIT ITEM
===================================================== */

function editItem(item) {

  if (!item) {
    return;
  }


  editingId =
    Number(item.id);


  const name =
    document.getElementById("name");

  const category =
    document.getElementById("category");

  const unit =
    document.getElementById("unit");

  const packageSize =
    document.getElementById("package_size");

  const packageUnit =
    document.getElementById("package_unit");

  const stock =
    document.getElementById(
      "stock_quantity"
    );

  const minimum =
    document.getElementById(
      "minimum_stock"
    );

  const price =
    document.getElementById(
      "purchase_price"
    );

  const supplier =
    document.getElementById(
      "supplier"
    );


  if (name) {
    name.value =
      item.name || "";
  }

  if (category) {
    category.value =
      item.category || "";
  }

  if (unit) {
    unit.value =
      item.unit || "";
  }

  if (packageSize) {
    packageSize.value =
      item.package_size ?? "";
  }

  if (packageUnit) {
    packageUnit.value =
      item.package_unit || "";
  }

  if (stock) {
    stock.value =
      item.stock_quantity ?? "";
  }

  if (minimum) {
    minimum.value =
      item.minimum_stock ?? "";
  }

  if (price) {
    price.value =
      item.purchase_price ?? "";
  }

  if (supplier) {
    supplier.value =
      item.supplier || "";
  }


  setEditMode(true);


  const form =
    document.getElementById(
      "inventory-form"
    );


  if (form) {

    form.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}


/* =====================================================
   STOCK IN / OUT
===================================================== */

async function stockIn(id) {

  await openStockModal(
    id,
    "IN"
  );
}


async function stockOut(id) {

  await openStockModal(
    id,
    "OUT"
  );
}


/* =====================================================
   OPEN STOCK MODAL
===================================================== */

async function openStockModal(
  id,
  type
) {

  try {

    const item =
      inventoryItems.find(
        inventoryItem =>
          Number(
            inventoryItem.id
          ) === Number(id)
      );


    if (!item) {

      alert(
        "Inventory item not found."
      );

      return;
    }


    if (!isItemActive(item)) {

      alert(
        "Inactive inventory items cannot receive stock transactions. Activate the item first."
      );

      return;
    }


    stockTransactionId =
      item.id;

    stockTransactionType =
      type;

    stockTransactionUnit =
      item.unit;

    stockTransactionCurrentStock =
      Number(
        item.stock_quantity || 0
      );


    setText(
      "stock-item-name",
      item.name
    );


    setText(
      "stock-current-value",
      `${formatNumber(
        item.stock_quantity
      )} ${item.unit || ""}`
    );


    const quantityInput =
      document.getElementById(
        "stock-quantity"
      );


    const noteInput =
      document.getElementById(
        "stock-note"
      );


    if (quantityInput) {
      quantityInput.value = "";
    }


    if (noteInput) {
      noteInput.value = "";
    }


    showStockError("");


    const title =
      document.getElementById(
        "stock-modal-title"
      );


    const subtitle =
      document.getElementById(
        "stock-modal-subtitle"
      );


    const confirmButton =
      document.getElementById(
        "stock-confirm-btn"
      );


    if (type === "IN") {

      title.innerText =
        "📥 Stock In";

      subtitle.innerText =
        "Add stock to inventory";

      confirmButton.innerText =
        "📥 Confirm Stock In";

      confirmButton.className =
        "btn btn-success";

    } else {

      title.innerText =
        "📤 Stock Out";

      subtitle.innerText =
        "Remove stock from inventory";

      confirmButton.innerText =
        "📤 Confirm Stock Out";

      confirmButton.className =
        "btn btn-danger";
    }


    const modal =
      document.getElementById(
        "stock-modal"
      );


    if (modal) {

      modal.style.display =
        "block";
    }


    setTimeout(() => {

      quantityInput?.focus();

    }, 100);

  } catch (error) {

    console.error(
      "openStockModal:",
      error
    );

    alert(
      error.message ||
      "Unable to open stock transaction."
    );
  }
}


/* =====================================================
   CLOSE STOCK MODAL
===================================================== */

function closeStockModal() {

  const modal =
    document.getElementById(
      "stock-modal"
    );


  if (modal) {
    modal.style.display =
      "none";
  }


  stockTransactionId =
    null;

  stockTransactionType =
    null;

  stockTransactionUnit =
    null;

  stockTransactionCurrentStock =
    0;
}


/* =====================================================
   APPLY BULK CALC - FIXED
===================================================== */

function applyBulkCalc() {
  const qty = parseFloat(document.getElementById('bulk-qty').value);
  const multiplier = parseFloat(document.getElementById('bulk-unit').value);
  const totalPrice = parseFloat(document.getElementById('bulk-total-price').value);

  if (!qty || !totalPrice) {
    alert('Bulk quantity aur total price dono bharo');
    return;
  }

  if (qty <= 0 || totalPrice <= 0) {
    alert('Quantity aur price positive numbers honi chahiye');
    return;
  }

  const baseQty = qty * multiplier;
  const pricePerUnit = totalPrice / baseQty;

  // FIX: Directly set values without any extra conversion
  const stockField = document.getElementById('stock_quantity');
  const priceField = document.getElementById('purchase_price');

  if (stockField) {
    stockField.value = baseQty;
    // Trigger change event so any listeners know value changed
    stockField.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (priceField) {
    priceField.value = pricePerUnit.toFixed(2);
    priceField.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Show confirmation to user
  alert(`✅ Stock quantity set to: ${baseQty}\n✅ Price per unit: Rs ${pricePerUnit.toFixed(2)}`);
}


/* =====================================================
   PARSE SMART QUANTITY - For Stock Transaction Modal Only
===================================================== */

function parseSmartQuantity(raw) {
  if (!raw) return NaN;

  const str = String(raw).trim().toLowerCase();
  
  // Check if it's a simple number first
  const simpleNumber = parseFloat(str);
  if (!isNaN(simpleNumber) && !str.match(/[a-z]/)) {
    return simpleNumber;
  }

  const match = str.match(/^([\d.]+)\s*(kg|g|l|ml|pcs)?$/);

  if (!match) return NaN;

  const value = parseFloat(match[1]);
  const unit = match[2];

  if (!unit) return value;

  if (unit === 'kg') return value * 1000;
  if (unit === 'l') return value * 1000;
  return value;
}



/* =====================================================
   CONFIRM STOCK TRANSACTION
===================================================== */

async function confirmStockTransaction() {

  if (
    !stockTransactionId ||
    !stockTransactionType
  ) {
    return;
  }


  const quantity = parseSmartQuantity(
  document.getElementById("stock-quantity")?.value
);



  const note =
    document.getElementById(
      "stock-note"
    )?.value.trim() || "";


  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {

    showStockError(
      "Please enter a valid quantity."
    );

    return;
  }


  if (
    stockTransactionType === "OUT" &&
    quantity >
    stockTransactionCurrentStock
  ) {

    showStockError(
      `Insufficient stock. Available stock is ${formatNumber(
        stockTransactionCurrentStock
      )} ${stockTransactionUnit || ""}.`
    );

    return;
  }


  const confirmButton =
    document.getElementById(
      "stock-confirm-btn"
    );


  if (confirmButton) {

    confirmButton.disabled =
      true;

    confirmButton.innerText =
      "Processing...";
  }


  try {

    const data =
      await apiRequest(
        `/api/inventory/${stockTransactionId}/transaction`,
        {
          method: "POST",

          body: JSON.stringify({
            type:
              stockTransactionType,

            quantity,

            note
          })
        }
      );


    if (!data.success) {

      showStockError(
        data.message ||
        "Transaction failed."
      );

      return;
    }


    closeStockModal();


    await refreshInventoryData();


    alert(
      data.message ||
      "Stock transaction completed successfully."
    );

  } catch (error) {

    console.error(
      "confirmStockTransaction:",
      error
    );

    showStockError(
      error.message ||
      "Something went wrong. Please try again."
    );

  } finally {

    const modal =
      document.getElementById(
        "stock-modal"
      );


    if (
      modal &&
      modal.style.display === "block" &&
      confirmButton
    ) {

      confirmButton.disabled =
        false;

      confirmButton.innerText =
        stockTransactionType === "IN"
          ? "📥 Confirm Stock In"
          : "📤 Confirm Stock Out";
    }
  }
}


/* =====================================================
   STOCK ERROR
===================================================== */

function showStockError(message) {

  const error =
    document.getElementById(
      "stock-error"
    );


  if (!error) {
    return;
  }


  error.innerText =
    message || "";


  error.style.display =
    message
      ? "block"
      : "none";
}


/* =====================================================
   HISTORY
===================================================== */

async function showHistory(
  id,
  name
) {

  try {

    const data =
      await apiRequest(
        `/api/inventory/${id}/transactions`
      );


    if (!data.success) {

      alert(
        data.message ||
        "Unable to load history."
      );

      return;
    }


    /*
      Kitchen-request-driven stock deductions are
      excluded from the visible History list, per
      business requirement. Stock quantity itself
      is unaffected — this only hides the rows.
    */

    const visibleTransactions =
      filterOutKitchenTransactions(
        Array.isArray(data.data)
          ? data.data
          : []
      );


    // Store currently opened audit data
    window.currentInventoryAudit = {
      id: Number(id),
      name: String(name || ""),
      transactions: visibleTransactions
    };


    const modal =
      document.getElementById(
        "history-modal"
      );


    const title =
      document.getElementById(
        "history-title"
      );


    const list =
      document.getElementById(
        "history-list"
      );


    if (title) {

      title.innerText =
        `📋 ${name} - Stock History`;
    }


    if (!list) {
      return;
    }


    if (
      !visibleTransactions.length
    ) {

      list.innerHTML = `

        <div class="history-empty">

          No transaction history found.

        </div>

      `;

    } else {

      list.innerHTML =
        visibleTransactions.map(
          transaction => {

            const isIn =
              String(
                transaction.type
              ).toUpperCase() === "IN";


            const date =
              transaction.created_at
                ? new Date(
                    transaction.created_at
                  ).toLocaleString()
                : "-";


            return `

              <div
                class="
                  history-item
                  ${isIn
                    ? "history-in"
                    : "history-out"}
                ">

                <div class="history-type">

                  ${
                    isIn
                      ? "📥 Stock In"
                      : "📤 Stock Out"
                  }

                </div>


                <div class="history-quantity">

                  ${isIn ? "+" : "-"}

                  ${formatNumber(
                    transaction.quantity
                  )}

                  ${escapeHtml(
                    transaction.unit || ""
                  )}

                </div>


                <div class="history-note">

                  Note:
                  ${
                    transaction.note
                      ? escapeHtml(
                          transaction.note
                        )
                      : "-"
                  }

                </div>


                <div class="history-date">

                  ${escapeHtml(date)}

                </div>

              </div>

            `;
          }
        ).join("");
    }


    if (modal) {
      modal.style.display =
        "block";
    }

  } catch (error) {

    console.error(
      "showHistory:",
      error
    );

    alert(
      error.message ||
      "Unable to load stock history."
    );
  }
}


function closeHistory() {

  const modal =
    document.getElementById(
      "history-modal"
    );


  if (modal) {

    modal.style.display =
      "none";
  }
}


/* =====================================================
   DASHBOARD
===================================================== */

async function loadDashboard() {

  try {

    const data =
      await apiRequest(
        "/api/inventory/dashboard"
      );


    if (!data.success) {

      console.error(
        data.message
      );

      return;
    }


    const dashboard =
      data.dashboard || {};


    const today =
      data.today || {};


    setText(
      "total-items",
      dashboard.total_items || 0
    );


    setText(
      "stock-value",
      "Rs " +
      Number(
        dashboard.total_stock_value || 0
      ).toLocaleString(
        "en-PK",
        {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }
      )
    );


    setText(
      "low-stock-items",
      dashboard.low_stock_items || 0
    );


    setText(
      "healthy-items",
      dashboard.healthy_items || 0
    );


    setText(
      "today-stock-in",
      today.today_stock_in || 0
    );


    setText(
      "today-stock-out",
      today.today_stock_out || 0
    );


    const lowList =
      document.getElementById(
        "dashboard-low-stock"
      );


    if (lowList) {

      if (
        !data.lowStock ||
        !data.lowStock.length
      ) {

        lowList.innerHTML = `

          <div class="dashboard-empty">

            🟢 All active inventory items
            have healthy stock.

          </div>

        `;

      } else {

        lowList.innerHTML =
          data.lowStock.map(
            item => `

              <div class="dashboard-low-item">

                <div>

                  <div class="dashboard-low-name">

                    ${escapeHtml(
                      item.name
                    )}

                  </div>

                  <div class="transaction-date">

                    ${escapeHtml(
                      item.category || ""
                    )}

                  </div>

                </div>


                <div class="dashboard-low-stock">

                  ${formatNumber(
                    item.stock_quantity
                  )}

                  ${escapeHtml(
                    item.unit || ""
                  )}

                  <br>

                  <small>

                    Minimum:
                    ${formatNumber(
                      item.minimum_stock
                    )}

                  </small>

                </div>

              </div>

            `
          ).join("");
      }
    }


    /*
      Kitchen-request-driven stock deductions are
      excluded from the visible Recent Transactions
      list, per business requirement. Stock quantity
      itself is unaffected — this only hides the rows.
    */

    const visibleRecentTransactions =
      filterOutKitchenTransactions(
        data.recentTransactions
      );


    const transactionList =
      document.getElementById(
        "dashboard-transactions"
      );


    if (transactionList) {

      if (
        !visibleRecentTransactions.length
      ) {

        transactionList.innerHTML = `

          <div class="dashboard-empty">

            No recent transactions.

          </div>

        `;

      } else {

        transactionList.innerHTML =
          visibleRecentTransactions.map(
            transaction => {

              const isIn =
                String(
                  transaction.type
                ).toUpperCase() === "IN";


              const date =
                transaction.created_at
                  ? new Date(
                      transaction.created_at
                    ).toLocaleString()
                  : "-";


              return `

                <div class="dashboard-transaction">

                  <div>

                    <div class="transaction-name">

                      ${escapeHtml(
                        transaction.name
                      )}

                    </div>

                    <div class="transaction-date">

                      ${escapeHtml(date)}

                    </div>

                  </div>


                  <div
                    class="${
                      isIn
                        ? "transaction-in"
                        : "transaction-out"
                    }">

                    ${isIn ? "+" : "-"}

                    ${formatNumber(
                      transaction.quantity
                    )}

                    ${escapeHtml(
                      transaction.unit || ""
                    )}

                  </div>

                </div>

              `;
            }
          ).join("");
      }
    }

  } catch (error) {

    console.error(
      "loadDashboard:",
      error
    );
  }
}


/* =====================================================
   LOADING
===================================================== */

function showInventoryLoading() {

  const list =
    document.getElementById(
      "inventory-list"
    );


  if (list) {

    list.innerHTML = `

      <div class="inventory-state">

        <div class="inventory-state-icon">
          ⏳
        </div>

        <div class="inventory-state-title">
          Loading inventory
        </div>

        <div class="inventory-state-text">
          Please wait...
        </div>

      </div>

    `;
  }


  const count =
    document.getElementById(
      "inventory-result-count"
    );


  if (count) {

    count.innerText =
      "Loading inventory...";
  }
}


/* =====================================================
   ERROR STATE
===================================================== */

function showInventoryError(
  message
) {

  const list =
    document.getElementById(
      "inventory-list"
    );


  if (list) {

    list.innerHTML = `

      <div class="inventory-state">

        <div class="inventory-state-icon">
          ⚠️
        </div>

        <div class="inventory-state-title">
          Unable to load inventory
        </div>

        <div class="inventory-state-text">

          ${escapeHtml(message)}

        </div>

        <button
          type="button"
          class="retry-btn"
          onclick="loadItems()">

          🔄 Try Again

        </button>

      </div>

    `;
  }


  const count =
    document.getElementById(
      "inventory-result-count"
    );


  if (count) {

    count.innerText =
      "Inventory unavailable";
  }
}


/* =====================================================
   FORMATTING
===================================================== */

function formatNumber(value) {

  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return "0";
  }


  return number.toLocaleString(
    "en-PK",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }
  );
}


function formatMoney(value) {

  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return "0.00";
  }


  return number.toLocaleString(
    "en-PK",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }
  );
}


/* =====================================================
   SAFE HTML ESCAPE
   FIXED
===================================================== */

function escapeHtml(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";
  }


  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* =====================================================
   SMALL DOM HELPER
===================================================== */

function setText(
  id,
  value
) {

  const element =
    document.getElementById(id);


  if (element) {

    element.innerText =
      value;
  }
}


/* =====================================================
   GLOBAL CLICK
===================================================== */

window.addEventListener(
  "click",
  function(event) {

    const historyModal =
      document.getElementById(
        "history-modal"
      );


    const stockModal =
      document.getElementById(
        "stock-modal"
      );


    if (
      event.target ===
      historyModal
    ) {

      closeHistory();
    }


    if (
      event.target ===
      stockModal
    ) {

      closeStockModal();
    }
  }
);


/* =====================================================
   ESC KEY
===================================================== */

document.addEventListener(
  "keydown",
  function(event) {

    if (
      event.key !== "Escape"
    ) {

      return;
    }


    closeHistory();

    closeStockModal();
  }
);


/* =====================================================
   INITIALIZE
===================================================== */

async function initializeInventoryPage() {

  initializeTheme();

  initializeInventoryControls();

  await loadItems();

  await loadDashboard();
}


initializeInventoryPage();

/* =====================================================
   INVENTORY AUDIT EXPORT / PRINT
===================================================== */

function exportInventoryAuditCSV() {

  const audit =
    window.currentInventoryAudit;

  if (!audit) {
    alert("Please open an inventory item's history first.");
    return;
  }

  const rows = [
    [
      "Inventory ID",
      "Item",
      "Transaction ID",
      "Type",
      "Quantity",
      "Unit",
      "Note",
      "Date"
    ]
  ];

  audit.transactions.forEach(transaction => {

    rows.push([
      audit.id,
      audit.name,
      transaction.id ?? "",
      transaction.type ?? "",
      transaction.quantity ?? "",
      transaction.unit ?? "",
      transaction.note ?? "",
      transaction.created_at
        ? new Date(transaction.created_at).toLocaleString()
        : ""
    ]);

  });

  const csv =
    rows
      .map(row =>
        row
          .map(value => {
            const text =
              String(value ?? "");

            return `"${text.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
      .join("\r\n");

  const blob =
    new Blob(
      [csv],
      {
        type: "text/csv;charset=utf-8;"
      }
    );

  const url =
    URL.createObjectURL(blob);

  const link =
    document.createElement("a");

  link.href = url;

  link.download =
    `${audit.name || "inventory"}-audit.csv`;

  document.body.appendChild(link);

  link.click();

  link.remove();

  URL.revokeObjectURL(url);
}


function printInventoryAudit() {

  const audit =
    window.currentInventoryAudit;

  if (!audit) {
    alert("Please open an inventory item's history first.");
    return;
  }

  const rows =
    audit.transactions
      .map(transaction => {

        const date =
          transaction.created_at
            ? new Date(
                transaction.created_at
              ).toLocaleString()
            : "-";

        const type =
          String(
            transaction.type || ""
          ).toUpperCase();

        const sign =
          type === "IN"
            ? "+"
            : type === "OUT"
              ? "-"
              : "";

        return `
          <tr>
            <td>${escapeHtml(date)}</td>
            <td>${escapeHtml(type)}</td>
            <td>
              ${sign}${formatNumber(transaction.quantity)}
              ${escapeHtml(transaction.unit || "")}
            </td>
            <td>${escapeHtml(transaction.note || "-")}</td>
          </tr>
        `;
      })
      .join("");

  const printWindow =
    window.open(
      "",
      "_blank",
      "width=1000,height=700"
    );

  if (!printWindow) {
    alert("Please allow pop-ups to print the audit.");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(audit.name)} - Inventory Audit</title>

      <style>
        body {
          font-family: Arial, sans-serif;
          color: #111827;
          padding: 30px;
        }

        h1 {
          margin-bottom: 5px;
        }

        .meta {
          color: #6b7280;
          margin-bottom: 25px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        th,
        td {
          border: 1px solid #d1d5db;
          padding: 9px;
          text-align: left;
        }

        th {
          background: #f3f4f6;
        }

        .footer {
          margin-top: 25px;
          color: #6b7280;
          font-size: 12px;
        }

        @media print {
          body {
            padding: 10px;
          }
        }
      </style>
    </head>

    <body>

      <h1>Inventory Audit</h1>

      <div class="meta">
        <strong>Item:</strong>
        ${escapeHtml(audit.name)}
        &nbsp;&nbsp;
        <strong>ID:</strong>
        ${escapeHtml(audit.id)}
      </div>

      <table>

        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Quantity</th>
            <th>Note</th>
          </tr>
        </thead>

        <tbody>
          ${
            rows ||
            `
              <tr>
                <td colspan="4">
                  No transaction history found.
                </td>
              </tr>
            `
          }
        </tbody>

      </table>

      <div class="footer">
        Generated from Restaurant POS Inventory
      </div>

    </body>
    </html>
  `);

  printWindow.document.close();

  printWindow.focus();

  setTimeout(() => {
    printWindow.print();
  }, 250);
}


/* =====================================================
   HISTORY AUDIT BUTTONS
===================================================== */

document.addEventListener(
  "click",
  event => {

    const printButton =
      event.target.closest(
        "#history-print-btn"
      );

    if (printButton) {
      printInventoryAudit();
      return;
    }

    const csvButton =
      event.target.closest(
        "#history-csv-btn"
      );

    if (csvButton) {
      exportInventoryAuditCSV();
      return;
    }

  }
);


/* =====================================================
   INVENTORY STOCK REPORT
===================================================== */

function getVisibleInventoryItems() {

  const searchInput =
    document.getElementById("inventory-search");

  const search =
    searchInput
      ? searchInput.value.trim().toLowerCase()
      : "";

  let items = [...inventoryItems];

  /*
    Same visibility rules as renderInventory()
  */
  if (
    currentFilter !== "inactive" &&
    !showInactiveItems
  ) {
    items =
      items.filter(item =>
        isItemActive(item)
      );
  }

  /* SEARCH */
  if (search) {
    items =
      items.filter(item => {

        const name =
          String(item.name || "").toLowerCase();

        const category =
          String(item.category || "").toLowerCase();

        const supplier =
          String(item.supplier || "").toLowerCase();

        const unit =
          String(item.unit || "").toLowerCase();

        return (
          name.includes(search) ||
          category.includes(search) ||
          supplier.includes(search) ||
          unit.includes(search)
        );
      });
  }

  /* FILTER */
  if (currentFilter === "low") {
    items =
      items.filter(item => {

        if (!isItemActive(item)) {
          return false;
        }

        return Number(item.stock_quantity || 0) <=
          Number(item.minimum_stock || 0);
      });
  }

  if (currentFilter === "healthy") {
    items =
      items.filter(item => {

        if (!isItemActive(item)) {
          return false;
        }

        return Number(item.stock_quantity || 0) >
          Number(item.minimum_stock || 0);
      });
  }

  if (currentFilter === "inactive") {
    items =
      items.filter(item =>
        !isItemActive(item)
      );
  }

  items.sort(sortInventoryItems);

  return items;
}


/* =====================================================
   TOTAL REMAINING STOCK
===================================================== */

function updateInventoryTotalStock() {

  const totalElement =
    document.getElementById(
      "inventory-total-stock"
    );

  if (!totalElement) {
    return;
  }

  const items =
    getVisibleInventoryItems();

  /*
    Group quantities by unit so we don't
    incorrectly add kg + litres + pieces.
  */

  const totals = {};

  items.forEach(item => {

    const unit =
      String(item.unit || "")
        .trim() || "unit";

    const quantity =
      Number(item.stock_quantity || 0);

    totals[unit] =
      (totals[unit] || 0) + quantity;
  });

  const output =
    Object.entries(totals)
      .map(([unit, quantity]) =>
        `${formatNumber(quantity)} ${escapeHtml(unit)}`
      )
      .join(" &nbsp; | &nbsp; ");

  totalElement.innerHTML =
    output || "0";

}


/* =====================================================
   PRINT CURRENT INVENTORY VIEW
===================================================== */

function printInventoryStockReport() {

  const items =
    getVisibleInventoryItems();

  if (!items.length) {
    alert("No inventory items to print.");
    return;
  }

  const rows =
    items.map(item => {

      const active =
        isItemActive(item);

      const stock =
        Number(item.stock_quantity || 0);

      const minimum =
        Number(item.minimum_stock || 0);

      const status =
        !active
          ? "Inactive"
          : stock <= minimum
            ? "Low Stock"
            : "Healthy";

      return `
        <tr>
          <td>${escapeHtml(item.name || "-")}</td>
          <td>${escapeHtml(item.category || "-")}</td>
          <td>${formatNumber(stock)} ${escapeHtml(item.unit || "")}</td>
          <td>${formatNumber(minimum)} ${escapeHtml(item.unit || "")}</td>
          <td>Rs ${formatMoney(item.purchase_price)}</td>
          <td>${escapeHtml(item.supplier || "-")}</td>
          <td>${escapeHtml(status)}</td>
        </tr>
      `;

    }).join("");

  const printWindow =
    window.open(
      "",
      "_blank",
      "width=1200,height=800"
    );

  if (!printWindow) {
    alert("Please allow pop-ups to print inventory.");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>

      <title>Restaurant POS - Inventory Stock</title>

      <style>

        body {
          font-family: Arial, sans-serif;
          color: #111827;
          padding: 30px;
        }

        h1 {
          margin: 0 0 6px;
        }

        .meta {
          color: #6b7280;
          margin-bottom: 22px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        th,
        td {
          border: 1px solid #d1d5db;
          padding: 8px;
          text-align: left;
          font-size: 13px;
        }

        th {
          background: #f3f4f6;
        }

        .footer {
          margin-top: 25px;
          color: #6b7280;
          font-size: 12px;
        }

        @media print {
          body {
            padding: 10px;
          }
        }

      </style>

    </head>

    <body>

      <h1>📦 Inventory Stock Report</h1>

      <div class="meta">
        Current inventory view
        &nbsp; | &nbsp;
        Items: ${items.length}
      </div>

      <table>

        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Current Stock</th>
            <th>Minimum</th>
            <th>Purchase Price</th>
            <th>Supplier</th>
            <th>Status</th>
          </tr>
        </thead>

        <tbody>
          ${rows}
        </tbody>

      </table>

      <div class="footer">
        Generated from Restaurant POS Inventory
      </div>

    </body>
    </html>
  `);

  printWindow.document.close();
  printWindow.focus();

  setTimeout(() => {
    printWindow.print();
  }, 250);
}


/* =====================================================
   EXPORT CURRENT INVENTORY VIEW CSV
===================================================== */

function exportInventoryStockCSV() {

  const items =
    getVisibleInventoryItems();

  if (!items.length) {
    alert("No inventory items to export.");
    return;
  }

  const rows = [
    [
      "Inventory ID",
      "Item",
      "Category",
      "Current Stock",
      "Unit",
      "Minimum Stock",
      "Purchase Price",
      "Supplier",
      "Status"
    ]
  ];

  items.forEach(item => {

    const active =
      isItemActive(item);

    const stock =
      Number(item.stock_quantity || 0);

    const minimum =
      Number(item.minimum_stock || 0);

    const status =
      !active
        ? "Inactive"
        : stock <= minimum
          ? "Low Stock"
          : "Healthy";

    rows.push([
      item.id,
      item.name || "",
      item.category || "",
      stock,
      item.unit || "",
      minimum,
      item.purchase_price || 0,
      item.supplier || "",
      status
    ]);

  });

  const csv =
    rows
      .map(row =>
        row.map(value => {

          const text =
            String(value ?? "");

          return `"${text.replace(/"/g, '""')}"`;

        }).join(",")
      )
      .join("\n");

  const blob =
    new Blob(
      [csv],
      {
        type: "text/csv;charset=utf-8;"
      }
    );

  const url =
    URL.createObjectURL(blob);

  const link =
    document.createElement("a");

  link.href = url;
  link.download = "inventory-stock.csv";

  document.body.appendChild(link);

  link.click();

  link.remove();

  URL.revokeObjectURL(url);
}


/* =====================================================
   INVENTORY REPORT BUTTONS
===================================================== */

document.addEventListener(
  "click",
  event => {

    if (
      event.target.closest(
        "#inventory-print-btn"
      )
    ) {
      printInventoryStockReport();
      return;
    }

    if (
      event.target.closest(
        "#inventory-csv-btn"
      )
    ) {
      exportInventoryStockCSV();
      return;
    }

  }
);

/* =====================================================
   SET EDIT MODE
===================================================== */

function setEditMode(isEditing) {
  const title = document.getElementById("inventory-form-title");
  const saveBtn = document.getElementById("save-btn");

  if (title) {
    title.innerText = isEditing ? "✏️ Edit Inventory Item" : "➕ Add Inventory Item";
  }

  if (saveBtn) {
    saveBtn.innerText = isEditing ? "🔄 Update Item" : "💾 Save Item";
  }

  
}
