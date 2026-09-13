const inventoryModel = require("../models/inventoryModel");

// ======================================================
// GET ALL INVENTORY ITEMS
// GET /api/inventory?status=all|active|inactive
// ======================================================

exports.getAllItems = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

    const status = req.query.status || "all";

    const allowedStatus = [
      "all",
      "active",
      "inactive"
    ];

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid inventory status"
      });
    }

    const items =
      await inventoryModel.getAllItems(
        restaurantId,
        status
      );

    res.json({
      success: true,
      data: items
    });

  } catch (error) {

    console.error(
      "getAllItems:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// ADD INVENTORY ITEM
// POST /api/inventory
// ======================================================

exports.addItem = async (req, res) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const {
      name,
      category,
      unit,
      package_size = null,
      package_unit = null,
      stock_quantity = 0,
      minimum_stock = 0,
      purchase_price = 0,
      supplier
    } = req.body;

    // --------------------------------------------------
    // VALIDATION
    // --------------------------------------------------

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Item name is required"
      });
    }

    if (!unit || !String(unit).trim()) {
      return res.status(400).json({
        success: false,
        message: "Unit is required"
      });
    }

    let packageSize = null;

    if (
      package_size !== null &&
      package_size !== undefined &&
      String(package_size).trim() !== ""
    ) {
      packageSize = Number(package_size);

      if (
        !Number.isFinite(packageSize) ||
        packageSize <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Package size must be greater than 0"
        });
      }

      if (
        !package_unit ||
        !String(package_unit).trim()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Package unit is required when package size is provided"
        });
      }
    }

    const packageUnit =
      package_unit
        ? String(package_unit).trim()
        : null;

    const stock =
      Number(stock_quantity);

    const minimum =
      Number(minimum_stock);

    const purchase =
      Number(purchase_price);

    if (
      !Number.isFinite(stock) ||
      stock < 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Stock quantity must be 0 or greater"
      });
    }

    if (
      !Number.isFinite(minimum) ||
      minimum < 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Minimum stock must be 0 or greater"
      });
    }

    if (
      !Number.isFinite(purchase) ||
      purchase < 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Purchase price must be 0 or greater"
      });
    }

    // --------------------------------------------------
    // CREATE ITEM
    // --------------------------------------------------

    const item =
      await inventoryModel.createItem({
        name: String(name).trim(),

        category:
          category
            ? String(category).trim()
            : "Other",

        unit:
          String(unit).trim(),

        package_size:
          packageSize,

        package_unit:
          packageUnit,

        stock_quantity: stock,

        minimum_stock: minimum,

        purchase_price: purchase,

        supplier:
          supplier
            ? String(supplier).trim()
            : null,

        restaurant_id:
          restaurantId
      });

    // --------------------------------------------------
    // OPENING STOCK TRANSACTION
    // --------------------------------------------------

    if (stock > 0) {
      await inventoryModel.addTransaction({
        inventory_id: item.id,

        restaurant_id: restaurantId,

        type: "IN",

        quantity: stock,

        note: "Opening Stock"
      });
    }

    // Get final item after transaction
    const finalItem =
      await inventoryModel.getItemById(
        item.id,
        restaurantId
      );

    res.status(201).json({
      success: true,
      message:
        "Inventory item added successfully",
      data: finalItem
    });

  } catch (error) {

    console.error(
      "addItem:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// UPDATE INVENTORY ITEM
// PUT /api/inventory/:id
// Manager only through route
// ======================================================

exports.updateItem = async (req, res) => {
  try {



    const { id } = req.params;

    const restaurantId =
  req.user.restaurant_id;

console.log("===== INVENTORY UPDATE DEBUG =====");
console.log("ID:", id);
console.log("USER:", req.user);
console.log("RESTAURANT ID:", restaurantId);

    const {
      name,
      category,
      unit,
      package_size,
      package_unit,
      minimum_stock,
      purchase_price,
      supplier
    } = req.body;

    // --------------------------------------------------
    // VALIDATION
    // --------------------------------------------------

    const updateData = {};
    console.log("===== UPDATE INVENTORY DEBUG =====");
console.log("REQ BODY:", req.body);

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({
          success: false,
          message: "Name cannot be empty"
        });
      }

      updateData.name =
        String(name).trim();
    }

    if (category !== undefined) {
      updateData.category =
        String(category).trim();
    }

    if (unit !== undefined) {
      if (!String(unit).trim()) {
        return res.status(400).json({
          success: false,
          message: "Unit cannot be empty"
        });
      }

      updateData.unit =
        String(unit).trim();
    }

    if (
      package_size !== undefined ||
      package_unit !== undefined
    ) {
      if (
        package_size !== undefined &&
        package_size !== null &&
        String(package_size).trim() !== ""
      ) {
        const packageSize =
          Number(package_size);

        if (
          !Number.isFinite(packageSize) ||
          packageSize <= 0
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Package size must be greater than 0"
          });
        }

        updateData.package_size =
          packageSize;
      } else if (
        package_size === null ||
        String(package_size || "").trim() === ""
      ) {
        updateData.package_size = null;
      }

      if (
        package_unit !== undefined
      ) {
        if (
          package_unit === null ||
          !String(package_unit).trim()
        ) {
          if (
            updateData.package_size !== null &&
            updateData.package_size !== undefined
          ) {
            return res.status(400).json({
              success: false,
              message:
                "Package unit is required when package size is provided"
            });
          }

          updateData.package_unit = null;
        } else {
          updateData.package_unit =
            String(package_unit).trim();
        }
      }
    }

    if (
      minimum_stock !== undefined
    ) {
      const minimum =
        Number(minimum_stock);

      if (
        !Number.isFinite(minimum) ||
        minimum < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Minimum stock must be 0 or greater"
        });
      }

      updateData.minimum_stock =
        minimum;
    }

    if (
      purchase_price !== undefined
    ) {
      const purchase =
        Number(purchase_price);

      if (
        !Number.isFinite(purchase) ||
        purchase < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Purchase price must be 0 or greater"
        });
      }

      updateData.purchase_price =
        purchase;
    }

    if (supplier !== undefined) {
      updateData.supplier =
        supplier
          ? String(supplier).trim()
          : null;
    }

    // --------------------------------------------------
    // UPDATE
    // --------------------------------------------------

 console.log("UPDATE DATA:", updateData);

    const item =


      await inventoryModel.updateItem(
        id,
        restaurantId,

        updateData
      );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Inventory item not found"
      });
    }

    res.json({
      success: true,
      message:
        "Inventory item updated successfully",
      data: item
    });

  } catch (error) {

    console.error(
      "updateItem:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// DEACTIVATE INVENTORY ITEM
// PATCH /api/inventory/:id/deactivate
// ======================================================

exports.deactivateItem = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { id } = req.params;

    const item =
      await inventoryModel.setItemActive(
        id,
        restaurantId,
        false
      );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Inventory item not found"
      });
    }

    res.json({
      success: true,
      message:
        "Inventory item deactivated successfully",
      data: item
    });

  } catch (error) {

    console.error(
      "deactivateItem:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// ACTIVATE INVENTORY ITEM
// PATCH /api/inventory/:id/activate
// ======================================================

exports.activateItem = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { id } = req.params;

    const item =
      await inventoryModel.setItemActive(
        id,
        restaurantId,
        true
      );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Inventory item not found"
      });
    }

    res.json({
      success: true,
      message:
        "Inventory item activated successfully",
      data: item
    });

  } catch (error) {

    console.error(
      "activateItem:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// ADD STOCK TRANSACTION
// POST /api/inventory/:id/transaction
// ======================================================

exports.addTransaction = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { id } = req.params;

    const {
      type,
      quantity,
      note
    } = req.body;

    // --------------------------------------------------
    // VALIDATION
    // --------------------------------------------------

    if (!type) {
      return res.status(400).json({
        success: false,
        message:
          "Transaction type is required"
      });
    }

    const amount =
      Number(quantity);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be greater than 0"
      });
    }

    // --------------------------------------------------
    // TRANSACTION
    // --------------------------------------------------

    const result =
      await inventoryModel.addTransaction({
        inventory_id: id,

        restaurant_id:
          restaurantId,

        type,

        quantity: amount,

        note:
          note
            ? String(note).trim()
            : null
      });

    res.json({
      success: true,
      message:
        "Stock updated successfully",
      data: result
    });

  } catch (error) {

    console.error(
      "addTransaction:",
      error
    );

    if (
      error.message ===
      "Inventory item not found"
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Inventory item not found"
      });
    }

    if (
      error.message ===
      "Inventory item is inactive"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Inventory item is inactive"
      });
    }

    if (
      error.message ===
      "Insufficient stock"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Not enough stock"
      });
    }

    if (
      error.message ===
      "Invalid transaction type"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid transaction type"
      });
    }

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// GET TRANSACTIONS
// GET /api/inventory/:id/transactions
// ======================================================

exports.getTransactions = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { id } = req.params;

    const transactions =
      await inventoryModel.getTransactions(
        id,
        restaurantId
      );

    res.json({
      success: true,
      data: transactions
    });

  } catch (error) {

    console.error(
      "getTransactions:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// GET RECIPE
// GET /api/inventory/recipe/:menuItemId
// ======================================================

exports.getRecipe = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { menuItemId } =
      req.params;

    
    const variantId = req.query.variant_id ? Number(req.query.variant_id) : null;

    const recipe =
      await inventoryModel.getRecipe(
        menuItemId,
        restaurantId,
        variantId 
      );

    res.json({
      success: true,
      data: recipe
    });

  } catch (error) {

    console.error(
      "getRecipe:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// ADD RECIPE INGREDIENT
// POST /api/inventory/recipe/:menuItemId
// Manager only through route
// ======================================================

exports.addRecipeIngredient = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { menuItemId } =
      req.params;

    const {
      inventory_id,
      quantity,
      variant_id
    } = req.body;

    if (!inventory_id) {
      return res.status(400).json({
        success: false,
        message:
          "Inventory item is required"
      });
    }

    const amount =
      Number(quantity);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be greater than 0"
      });
    }

    const ingredient =
      await inventoryModel.addRecipeIngredient({
        menu_item_id:
          menuItemId,

        inventory_id,

        variant_id:
          variant_id || null,

        quantity: amount,

        restaurant_id:
          restaurantId
      });

    res.status(201).json({
      success: true,
      message:
        "Ingredient added to recipe successfully",
      data: ingredient
    });

  } catch (error) {

    console.error(
      "addRecipeIngredient:",
      error
    );

    if (
      error.code === "23505"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "This ingredient is already added to this recipe"
      });
    }

    if (
      error.message ===
      "Inventory item not found"
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Inventory item not found"
      });
    }

    if (
      error.message ===
      "Menu item not found"
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Menu item not found"
      });
    }

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// UPDATE RECIPE INGREDIENT
// PATCH /api/inventory/recipe/ingredient/:id
// ======================================================

exports.updateRecipeIngredient = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { id } = req.params;

    const {
      quantity
    } = req.body;

    const amount =
      Number(quantity);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Valid quantity is required"
      });
    }

    const ingredient =
      await inventoryModel.updateRecipeIngredient(
        id,
        amount,
        restaurantId
      );

    if (!ingredient) {
      return res.status(404).json({
        success: false,
        message:
          "Recipe ingredient not found"
      });
    }

    res.json({
      success: true,
      message:
        "Recipe quantity updated successfully",
      data: ingredient
    });

  } catch (error) {

    console.error(
      "updateRecipeIngredient:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// DELETE RECIPE INGREDIENT
// DELETE /api/inventory/recipe/ingredient/:id
// ======================================================

exports.deleteRecipeIngredient = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurant_id;

    const { id } = req.params;

    const ingredient =
      await inventoryModel.deleteRecipeIngredient(
        id,
        restaurantId
      );

    if (!ingredient) {
      return res.status(404).json({
        success: false,
        message:
          "Recipe ingredient not found"
      });
    }

    res.json({
      success: true,
      message:
        "Ingredient removed from recipe successfully",
      data: ingredient
    });

  } catch (error) {

    console.error(
      "deleteRecipeIngredient:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
};


// ======================================================
// INVENTORY DASHBOARD
// GET /api/inventory/dashboard
// ======================================================

exports.getDashboard = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

   
    const data = await inventoryModel.getDashboard(restaurantId);

    res.json({
      success: true,
      dashboard: data.dashboard,       
      today: data.today,
      lowStock: data.lowStock,
      recentTransactions: data.recentTransactions
    });

  } catch (error) {
    console.error('getDashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
};