const pool = require('../config/db');


// ======================================================
// PRICING CALCULATOR
// ======================================================

const calculatePricing = (
  subtotal,
  discountType,
  discountValue,
  gstPercent,
  taxPercent
) => {

  subtotal = Number(subtotal || 0);
  discountValue = Number(discountValue || 0);
  gstPercent = Number(gstPercent || 0);
  taxPercent = Number(taxPercent || 0);
  
  let discountAmount = 0;

  if (discountType === 'percent') {

    discountAmount =
      subtotal * discountValue / 100;

  }

  else if (discountType === 'fixed') {

    discountAmount = discountValue;

  }

  discountAmount = Math.min(
    Math.max(discountAmount, 0),
    subtotal
  );

  const afterDiscount =
    subtotal - discountAmount;

  const gstAmount =
    afterDiscount * gstPercent / 100;

  const taxAmount =
    afterDiscount * taxPercent / 100;

  const totalAmount =
    afterDiscount +
    gstAmount +
    taxAmount;

  return {
    subtotal,
    discountAmount,
    gstAmount,
    taxAmount,
    totalAmount
  };
};


const deductStockForOrder = async (client, orderId, restaurantId) => {
    // Idempotency guard: the same order must never consume physical stock twice.
    const orderState = await client.query(
        `SELECT inventory_deducted_at
         FROM orders
         WHERE id = $1
           AND restaurant_id = $2
         FOR UPDATE`,
        [orderId, restaurantId]
    );

    if (!orderState.rowCount) {
        throw new Error('Order not found for inventory deduction.');
    }

    if (orderState.rows[0].inventory_deducted_at) {
        return false;
    }

    const ingredientsResult = await client.query(
        `SELECT mii.inventory_id, mii.quantity AS recipe_quantity, oi.quantity AS order_quantity
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
            AND (mii.variant_id IS NOT DISTINCT FROM oi.variant_id)
         WHERE oi.order_id = $1 AND mi.restaurant_id = $2`,
        [orderId, restaurantId]
    );
    if (!ingredientsResult.rows.length) {
        await client.query(
            `UPDATE orders
             SET inventory_deducted_at = COALESCE(inventory_deducted_at, NOW())
             WHERE id = $1
               AND restaurant_id = $2`,
            [orderId, restaurantId]
        );

        await client.query(
            `UPDATE inventory_reservations
             SET status = 'consumed',
                 released_at = NULL
             WHERE order_id = $1
               AND restaurant_id = $2
               AND status = 'reserved'`,
            [orderId, restaurantId]
        );

        return true;
    }

    const requiredStock = {};
    for (const row of ingredientsResult.rows) {
        const reqQty = Number(row.recipe_quantity) * Number(row.order_quantity);
        if (!Number.isFinite(reqQty) || reqQty <= 0) {
            throw new Error('Invalid recipe quantity.');
        }
        if (!requiredStock[row.inventory_id]) requiredStock[row.inventory_id] = 0;
        requiredStock[row.inventory_id] += reqQty;
    }

    // Lock each kitchen stock row before checking/deducting it. This prevents
    // concurrent serve operations from both reading the same stock level.
    for (const inventoryId of Object.keys(requiredStock)) {
        const qty = requiredStock[inventoryId];

        const stockResult = await client.query(
            `SELECT quantity
             FROM kitchen_inventory
             WHERE restaurant_id = $1
               AND inventory_id = $2
             FOR UPDATE`,
            [restaurantId, Number(inventoryId)]
        );

        if (!stockResult.rowCount) {
            throw new Error(`Kitchen inventory item \${inventoryId} not found.`);
        }

        const currentStock = Number(stockResult.rows[0].quantity || 0);

        if (!Number.isFinite(currentStock) || currentStock < qty) {
            throw new Error(
                `Insufficient kitchen stock for inventory item \${inventoryId} (available: \${currentStock}, required: \${qty})`
            );
        }

        const updated = await client.query(
            `UPDATE kitchen_inventory
             SET quantity = quantity - $1,
                 updated_at = NOW()
             WHERE restaurant_id = $2
               AND inventory_id = $3
               AND quantity >= $1
             RETURNING quantity`,
            [qty, restaurantId, Number(inventoryId)]
        );

        if (!updated.rowCount) {
            throw new Error(`Insufficient kitchen stock for inventory item \${inventoryId}.`);
        }
        
        await client.query(
            `INSERT INTO kitchen_inventory_transactions
             (kitchen_inventory_id, type, quantity, note, order_id)
             SELECT id, 'OUT', $1, $2, $3
             FROM kitchen_inventory
             WHERE restaurant_id = $4
               AND inventory_id = $5`,
            [
                qty,
                `Order #${orderId} completed — inventory consumption`,
                orderId,
                restaurantId,
                Number(inventoryId)
            ]
        );
    }

    // Mark the order consumed only after every stock deduction succeeded.
    await client.query(
        `UPDATE orders
         SET inventory_deducted_at = COALESCE(inventory_deducted_at, NOW())
         WHERE id = $1
           AND restaurant_id = $2`,
        [orderId, restaurantId]
    );

    // Reservations are consumed together with the physical deduction.
    await client.query(
        `UPDATE inventory_reservations
         SET status = 'consumed',
             released_at = NULL
         WHERE order_id = $1
           AND restaurant_id = $2
           AND status = 'reserved'`,
        [orderId, restaurantId]
    );

    return true;
};


// ======================================================
// PLACE-TIME INVENTORY AVAILABILITY CHECK
//
// IMPORTANT:
// - Inventory is ONLY checked here.
// - Inventory is NOT deducted here.
// - Actual deduction happens at SERVE time.
// - If any required ingredient is insufficient,
//   order creation is blocked.
// ======================================================

const checkOrderInventoryAvailability = async (
  client,
  orderId,
  restaurantId
) => {

  // ----------------------------------------------------
  // GET ALL INGREDIENT REQUIREMENTS
  //
  // recipe quantity × ordered quantity
  // ----------------------------------------------------

  const ingredientsResult =
    await client.query(
      `
      SELECT

        mii.inventory_id,

        ii.name AS ingredient_name,

        ii.unit,

        ki.quantity AS stock_quantity, 

        mii.quantity AS recipe_quantity,

        oi.quantity AS order_quantity

      FROM order_items oi

      INNER JOIN menu_items mi
        ON mi.id = oi.menu_item_id

      INNER JOIN menu_item_ingredients mii
        ON mii.menu_item_id = mi.id
        AND (mii.variant_id IS NOT DISTINCT FROM oi.variant_id)

      INNER JOIN inventory_items ii
        ON ii.id = mii.inventory_id

      INNER JOIN kitchen_inventory ki -- Added JOIN
        ON ki.inventory_id = ii.id
        AND ki.restaurant_id = $2

      WHERE oi.order_id = $1

        AND mi.restaurant_id = $2

        AND ii.restaurant_id = $2
      `,
      [
        orderId,
        restaurantId
      ]
    );


  // ----------------------------------------------------
  // NO RECIPES
  //
  // If menu items have no recipe,
  // there is nothing to validate.
  // ----------------------------------------------------

  if (!ingredientsResult.rows.length) {

    return {
      available: true
    };

  }


  // ----------------------------------------------------
  // CALCULATE TOTAL REQUIRED STOCK
  //
  // Same ingredient can be used by multiple
  // menu items in the same order.
  // ----------------------------------------------------

  const requiredStock = {};


  for (
    const row
    of ingredientsResult.rows
  ) {

    const inventoryId =
      row.inventory_id;


    const recipeQuantity =
      Number(row.recipe_quantity || 0);


    const orderQuantity =
      Number(row.order_quantity || 0);


    const requiredQuantity =
      recipeQuantity *
      orderQuantity;

    if (
      !Number.isFinite(recipeQuantity) ||
      recipeQuantity <= 0 ||
      !Number.isFinite(orderQuantity) ||
      orderQuantity <= 0 ||
      !Number.isFinite(requiredQuantity) ||
      requiredQuantity <= 0
    ) {
      const err = new Error('Invalid recipe or order quantity.');
      err.error = 'INVALID_INVENTORY_REQUIREMENT';
      err.ingredient = row.ingredient_name;
      throw err;
    }

    if (!requiredStock[inventoryId]) {

      requiredStock[inventoryId] = {

        inventory_id:
          inventoryId,

        ingredient_name:
          row.ingredient_name,

        unit:
          row.unit,

        required_quantity:
          0

      };

    }


    requiredStock[inventoryId]
      .required_quantity +=
      requiredQuantity;

  }


  // ----------------------------------------------------
  // CHECK CURRENT STOCK
  //
  // IMPORTANT:
  // No stock update happens here.
  // ----------------------------------------------------

  for (
    const inventoryId
    of Object.keys(requiredStock)
  ) {

    const item =
      requiredStock[inventoryId];


        const stockResult =
      await client.query(
        `
        SELECT
          ki.id,
          ii.name,
          ii.unit,
          ki.quantity AS stock_quantity
        FROM kitchen_inventory ki
        INNER JOIN inventory_items ii ON ii.id = ki.inventory_id
        WHERE ki.inventory_id = $1
          AND ki.restaurant_id = $2
        FOR UPDATE
        `,
        [
          item.inventory_id,
          restaurantId
        ]
      );

    if (!stockResult.rows.length) {
      const err = new Error(`Kitchen item "${item.ingredient_name}" not found.`);
      err.error = 'KITCHEN_STOCK_NOT_FOUND';
      err.ingredient = item.ingredient_name;
      throw err;
    }

    const stock = Number(stockResult.rows[0].stock_quantity || 0);


const reservedResult = await client.query(
  `
  SELECT COALESCE(SUM(quantity), 0) AS reserved_quantity
  FROM inventory_reservations
  WHERE inventory_id = $1
    AND restaurant_id = $2
    AND status = 'reserved'
  `,
  [item.inventory_id, restaurantId]
);
const alreadyReserved = Number(reservedResult.rows[0].reserved_quantity || 0);
const available = stock - alreadyReserved;

if (available < item.required_quantity) {
  const err = new Error('Insufficient kitchen stock');
  err.error = 'INSUFFICIENT_KITCHEN_STOCK';
  err.ingredient = item.ingredient_name;
  err.available = available;
  err.required = item.required_quantity;
  err.unit = item.unit;
  throw err;
}
    
  }


  // ----------------------------------------------------
  // EVERYTHING AVAILABLE
  // ----------------------------------------------------

  return {
    available: true
  };

};


// ======================================================
// CREATE ORDER
// ======================================================

const createOrder = async (
  tableNo,
  items,
  restaurantId,
  customerName = null,
  status = 'pending',
  pricing = {},
  orderType = 'dine_in',
  deliveryPhone = null,
  deliveryAddress = null,
  orderSource = 'MENU',
  paymentTiming = 'PAY_LATER',
  paidAmount = 0,
  deals = [],
  createdByUserId = null,
  deliveryCharge = 0,
  dineCharge = 0,
  paymentMethod = null
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    // --------------------------------------------------
    // VALIDATE STATUS
    // --------------------------------------------------

    const allowedStatuses = [
      'pending',
      'placed',
      'accepted',
      'preparing',
      'confirmed',
      'ready',
      'served',
      'payment_pending',
      'ready_to_deliver',
      'out_for_delivery',
      'delivered',
      'paid',
      'completed',
      'cancelled'
    ];


    if (
      !allowedStatuses.includes(status)
    ) {

      throw new Error(
        'Invalid order status.'
      );

    }


    // --------------------------------------------------
    // VALIDATE ORDER SOURCE
    // --------------------------------------------------

    const allowedSources = [
      'MENU',
      'WAITER',
      'COUNTER',
      'PHONE'
    ];


    if (
      !allowedSources.includes(orderSource)
    ) {

      throw new Error(
        'Invalid order source.'
      );

    }


    // --------------------------------------------------
    // VALIDATE PAYMENT TIMING
    // --------------------------------------------------

    const allowedPaymentTiming = [
      'PAY_LATER',
      'PAID_AT_ORDER',
      'COD'
    ];


    if (
      !allowedPaymentTiming.includes(
        paymentTiming
      )
    ) {

      throw new Error(
        'Invalid payment timing.'
      );

    }


    // --------------------------------------------------
    // VALIDATE ORDER TYPE
    // --------------------------------------------------

    if (
      !['dine_in', 'delivery','walk_in']
        .includes(orderType)
    ) {

      throw new Error(
        'Invalid order type.'
      );

    }


    // --------------------------------------------------
    // COD ONLY FOR DELIVERY
    // --------------------------------------------------

    if (
      paymentTiming === 'COD' &&
      orderType !== 'delivery'
    ) {

      throw new Error(
        'COD is only allowed for delivery orders.'
      );

    }


    // --------------------------------------------------
    // DELIVERY VALIDATION
    // --------------------------------------------------

    if (
      orderType === 'delivery'
    ) {

      if (
        !deliveryPhone ||
        !String(deliveryPhone).trim()
      ) {

        throw new Error(
          'Delivery phone is required.'
        );

      }


      if (
        !deliveryAddress ||
        !String(deliveryAddress).trim()
      ) {

        throw new Error(
          'Delivery address is required.'
        );

      }

    }


    // --------------------------------------------------
    // PAID AMOUNT VALIDATION
    // --------------------------------------------------

    let finalPaidAmount =
      Number(paidAmount || 0);


    if (
      !Number.isFinite(finalPaidAmount) ||
      finalPaidAmount < 0
    ) {

      throw new Error(
        'Invalid paid amount.'
      );

    }


    // --------------------------------------------------
    // ONLY PAID_AT_ORDER CAN HAVE PAID AMOUNT
    // --------------------------------------------------

    if (
      paymentTiming !== 'PAID_AT_ORDER'
    ) {

      finalPaidAmount = 0;

    }


    // --------------------------------------------------
    // PAYMENT STATUS
    // --------------------------------------------------

    const initialPaymentStatus =
      paymentTiming === 'PAID_AT_ORDER'
        ? 'paid'
        : 'unpaid';


    // --------------------------------------------------
    // PRICING
    // --------------------------------------------------

    const discountType =
      pricing.discount_type || 'none';

    const discountValue =
      Number(
        pricing.discount_value || 0
      );

    const gstPercent =
      Number(
        pricing.gst_percent || 0
      );

    const taxPercent =
      Number(
        pricing.tax_percent || 0
      );


    if (
      !['none', 'percent', 'fixed']
        .includes(discountType)
    ) {

      throw new Error(
        'Invalid discount type.'
      );

    }


    if (
      !Number.isFinite(discountValue) ||
      !Number.isFinite(gstPercent) ||
      !Number.isFinite(taxPercent)
    ) {

      throw new Error(
        'Pricing values must be valid numbers.'
      );

    }


    if (
      discountValue < 0 ||
      gstPercent < 0 ||
      taxPercent < 0
    ) {

      throw new Error(
        'Discount, GST and tax cannot be negative.'
      );

    }


    if (
      discountType === 'percent' &&
      discountValue > 100
    ) {

      throw new Error(
        'Percentage discount cannot exceed 100%.'
      );

    }


    if (
      gstPercent > 100
    ) {

      throw new Error(
        'GST percentage cannot exceed 100%.'
      );

    }


    if (
      taxPercent > 100
    ) {

      throw new Error(
        'Tax percentage cannot exceed 100%.'
      );

    }


    // --------------------------------------------------
    // CREATE ORDER
    // --------------------------------------------------

    // Atomically allocate the next restaurant-local order number.
    // The counter row is locked by PostgreSQL during the UPDATE/INSERT,
    // so concurrent orders cannot calculate the same local_number.
    const counterResult = await client.query(
      `
      INSERT INTO restaurant_order_counters
        (restaurant_id, next_number)
      VALUES
        ($1, 2)
      ON CONFLICT (restaurant_id)
      DO UPDATE
        SET next_number = restaurant_order_counters.next_number + 1
      RETURNING next_number - 1 AS local_number
      `,
      [restaurantId]
    );

    const localNumber = Number(counterResult.rows[0].local_number);

    const orderResult =
      await client.query(
        `
        INSERT INTO orders
        (
          table_no,
          local_number,
          restaurant_id,
          customer_name,
          status,

          order_type,
          delivery_phone,
          delivery_address,

          order_source,
          payment_timing,

          payment_status,
          payment_method,
          paid_amount,

          discount_type,
          discount_value,
          gst_percent,
          tax_percent,

          created_by_user_id,
          paid_by_user_id,
          delivery_charge,
          dine_charge,
          card_charge,
          bank_charge
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,

          $6::varchar,
          $7::varchar,
          $8::text,

          $9,

          $10,

          $11,
          $12,
          $13,
          $14,
          $15,
          $16,

          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23
        )

        RETURNING *
        `,
        [
          tableNo,
          localNumber,
          restaurantId,
          customerName,
          status,

          orderType,

          orderType === 'delivery'
            ? String(deliveryPhone).trim()
            : null,

          orderType === 'delivery'
            ? String(deliveryAddress).trim()
            : null,

          orderSource,
          paymentTiming,

          initialPaymentStatus,
          initialPaymentStatus === 'paid' ? (paymentMethod || 'Cash') : null,
          finalPaidAmount,

          discountType,
          discountValue,
          gstPercent,
          taxPercent,

          createdByUserId,

          initialPaymentStatus === 'paid'
            ? createdByUserId
            : null,
          0,
          0,
          0,
          0
        ]
      );


    const order =
      orderResult.rows[0];


    // --------------------------------------------------
    // ADD ORDER ITEMS
    // --------------------------------------------------

    if (
  (!Array.isArray(items) || items.length === 0) &&
  (!Array.isArray(deals) || deals.length === 0)
) {
  throw new Error(
    'At least one order item or deal is required.'
  );
}


    for (
      const item
      of items
    ) {

      const variantId =
        item.variant_id === undefined ||
        item.variant_id === null ||
        item.variant_id === ''
          ? null
          : Number(item.variant_id);

      if (
        !Number.isInteger(
          item.menu_item_id
        ) ||
        !Number.isInteger(
          item.quantity
        ) ||
        item.quantity <= 0 ||
        (
          variantId !== null &&
          (!Number.isInteger(variantId) || variantId <= 0)
        )
      ) {

        throw new Error(
          'Invalid order item.'
        );

      }


      const menuCheck =
        await client.query(
          `
          SELECT id, price

          FROM menu_items

          WHERE id = $1

            AND restaurant_id = $2
          `,
          [
            item.menu_item_id,
            restaurantId
          ]
        );


      if (
        !menuCheck.rowCount
      ) {

        throw new Error(
          `Menu item ${item.menu_item_id} not found.`
        );

      }


      let unitPrice = Number(menuCheck.rows[0].price);

      if (variantId !== null) {

        const variantCheck =
          await client.query(
            `
            SELECT id, price

            FROM menu_item_variants

            WHERE id = $1

              AND menu_item_id = $2

              AND active = true
            `,
            [
              variantId,
              item.menu_item_id
            ]
          );

        if (!variantCheck.rowCount) {

          throw new Error(
            `Size/pieces option for menu item ${item.menu_item_id} not found.`
          );

        }

        unitPrice = Number(variantCheck.rows[0].price);

      }


      await client.query(
        `
        INSERT INTO order_items
        (
          order_id,
          menu_item_id,
          variant_id,
          quantity,
          unit_price,
          line_total
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        `,
        [
          order.id,
          item.menu_item_id,
          variantId,
          item.quantity,
          unitPrice,
          item.quantity * unitPrice
        ]
      );

    }

        // --------------------------------------------------
    // ADD ORDER DEALS
    // --------------------------------------------------

    if (Array.isArray(deals) && deals.length) {

      for (const deal of deals) {

        const dealId = Number(deal.deal_id);
        const dealQuantity = Number(deal.quantity);

        if (
          !Number.isInteger(dealId) ||
          dealId <= 0 ||
          !Number.isInteger(dealQuantity) ||
          dealQuantity <= 0
        ) {

          throw new Error(
            'Invalid deal or quantity.'
          );

        }


        const dealCheck =
          await client.query(
            `
            SELECT id, price

            FROM deals

            WHERE id = $1

              AND restaurant_id = $2

              AND active = true
            `,
            [
              dealId,
              restaurantId
            ]
          );


        if (!dealCheck.rowCount) {

          throw new Error(
            `Deal ${dealId} not found.`
          );

        }


        const orderDealResult =
          await client.query(
            `
            INSERT INTO order_deals
            (
              order_id,
              deal_id,
              quantity,
              unit_price,
              line_total
            )

            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5
            )

            RETURNING id
            `,
            [
              order.id,
              dealId,
              dealQuantity,
              Number(dealCheck.rows[0].price),
              Number(dealQuantity) * Number(dealCheck.rows[0].price)
            ]
          );


        const orderDealId =
          orderDealResult.rows[0].id;


        const dealItemsResult =
          await client.query(
            `
            SELECT

              menu_item_id,

              variant_id,

              quantity

            FROM deal_items

            WHERE deal_id = $1
            `,
            [
              dealId
            ]
          );


        for (const dealItem of dealItemsResult.rows) {

          const dealItemPriceResult = await client.query(
            `SELECT COALESCE(miv.price, m.price) AS price
             FROM menu_items m
             LEFT JOIN menu_item_variants miv
               ON miv.id = $2 AND miv.menu_item_id = m.id
             WHERE m.id = $1 AND m.restaurant_id = $3`,
            [dealItem.menu_item_id, dealItem.variant_id, restaurantId]
          );

          if (!dealItemPriceResult.rowCount) {
            throw new Error(`Deal menu item ${dealItem.menu_item_id} not found.`);
          }

          const dealItemUnitPrice = Number(dealItemPriceResult.rows[0].price);

          await client.query(
            `
            INSERT INTO order_items
            (
              order_id,
              menu_item_id,
              variant_id,
              quantity,
              order_deal_id,
              unit_price,
              line_total
            )

            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
            )
            `,
            [
              order.id,
              dealItem.menu_item_id,
              dealItem.variant_id,
              dealItem.quantity * dealQuantity,
              orderDealId,
              dealItemUnitPrice,
              Number(dealItem.quantity * dealQuantity) * Number(dealItemUnitPrice)
            ]
          );

        }

      }

    }


    // ==================================================
    // PLACE-TIME INVENTORY AVAILABILITY CHECK
    //
    // IMPORTANT:
    //
    // 1. Recipe ingredients are checked here.
    // 2. Required quantity is calculated.
    // 3. Current stock is checked.
    // 4. If stock is insufficient, order is blocked.
    // 5. Inventory is NOT deducted here.
    // 6. Inventory deduction remains at SERVE.
    // ==================================================

    await checkOrderInventoryAvailability(
      client,
      order.id,
      restaurantId
    );

    // --------------------------------------------------
    // RESERVE INVENTORY
    //
    // Physical stock is NOT deducted here.
    // The required quantity is held against this order.
    // Actual deduction happens when the order is served.
    // --------------------------------------------------

    await reserveOrderInventory(
      client,
      order.id,
      restaurantId
    );


    // --------------------------------------------------
    // CALCULATE SUBTOTAL
    // --------------------------------------------------

        const subtotalResult =
      await client.query(
        `
        SELECT

          COALESCE(
            SUM(
              (oi.unit_price::numeric * oi.quantity::numeric)
            ),
            0
          ) AS subtotal

        FROM order_items oi

        INNER JOIN menu_items m
          ON m.id = oi.menu_item_id

        LEFT JOIN menu_item_variants miv
          ON miv.id = oi.variant_id

        WHERE oi.order_id = $1

          AND m.restaurant_id = $2

          AND oi.order_deal_id IS NULL
        `,
        [
          order.id,
          restaurantId
        ]
      );


    const dealsSubtotalResult =
      await client.query(
        `
        SELECT

          COALESCE(
            SUM(od.line_total),
            0
          ) AS subtotal

        FROM order_deals od

        INNER JOIN deals d
          ON d.id = od.deal_id

        WHERE od.order_id = $1

          AND d.restaurant_id = $2
        `,
        [
          order.id,
          restaurantId
        ]
      );


    const subtotal =
      Number(
        subtotalResult.rows[0].subtotal || 0
      ) +
      Number(
        dealsSubtotalResult.rows[0].subtotal || 0
      );


    // --------------------------------------------------
    // CALCULATE PRICING
    // --------------------------------------------------

    const calculated =
      calculatePricing(
        subtotal,
        discountType,
        discountValue,
        gstPercent,
        taxPercent
      );

         // Delivery/dine-in charges are restaurant-configured amounts.
    // Never trust client-supplied charge values.
    const chargeResult = await client.query(
      `SELECT
         COALESCE(
           NULLIF(pos_settings->>'delivery_charge','')::numeric,
           NULLIF(pos_settings->>'deliveryCharge','')::numeric,
           delivery_charge,
           0
         ) AS delivery_charge,
         COALESCE(
           NULLIF(pos_settings->>'dine_charge','')::numeric,
           NULLIF(pos_settings->>'dineCharge','')::numeric,
           dine_charge,
           0
         ) AS dine_charge,
         COALESCE(
           NULLIF(pos_settings->>'card_charge','')::numeric,
           NULLIF(pos_settings->>'cardCharge','')::numeric,
           card_charge,
           0
         ) AS card_charge,
         COALESCE(
           NULLIF(pos_settings->>'bank_charge','')::numeric,
           NULLIF(pos_settings->>'bankCharge','')::numeric,
           bank_charge,
           0
         ) AS bank_charge
       FROM restaurants
       WHERE id = $1
       FOR SHARE`,
      [restaurantId]
    );

    if (!chargeResult.rows.length) {
      throw new Error('Restaurant not found.');
    }

    const configuredDeliveryCharge = Number(chargeResult.rows[0].delivery_charge || 0);
    const configuredDineCharge = Number(chargeResult.rows[0].dine_charge || 0);

    if (
      !Number.isFinite(configuredDeliveryCharge) ||
      configuredDeliveryCharge < 0 ||
      !Number.isFinite(configuredDineCharge) ||
      configuredDineCharge < 0
    ) {
      throw new Error('Invalid restaurant charge configuration.');
    }

    const finalDeliveryCharge = orderType === 'delivery'
      ? configuredDeliveryCharge
      : 0;

    const finalDineCharge = orderType === 'dine_in'
      ? configuredDineCharge
      : 0;
    
        // Card/bank surcharge is always calculated from restaurant settings.
    // Never trust surcharge amounts supplied by the client.
    // Reuse charge row (already includes pos_settings card/bank %)
    const surchargeResult = chargeResult;

    const configuredCardPercent = Number(surchargeResult.rows[0].card_charge || 0);
    const configuredBankPercent = Number(surchargeResult.rows[0].bank_charge || 0);

    if (
      !Number.isFinite(configuredCardPercent) ||
      configuredCardPercent < 0 ||
      configuredCardPercent > 100 ||
      !Number.isFinite(configuredBankPercent) ||
      configuredBankPercent < 0 ||
      configuredBankPercent > 100
    ) {
      throw new Error('Invalid restaurant payment surcharge configuration.');
    }

    const normalizedPaymentMethod = String(paymentMethod || 'Cash');
    // Surcharge base = goods total + delivery/dine (matches counter-lite bill)
    const surchargeBase = Number(
      (calculated.totalAmount + finalDeliveryCharge + finalDineCharge).toFixed(2)
    );
    const finalCardCharge = normalizedPaymentMethod === 'Card'
      ? Number((surchargeBase * configuredCardPercent / 100).toFixed(2))
      : 0;
    const finalBankCharge = normalizedPaymentMethod === 'Bank'
      ? Number((surchargeBase * configuredBankPercent / 100).toFixed(2))
      : 0;

    const finalTotalAmount = Number(
      (
        calculated.totalAmount +
        finalDeliveryCharge +
        finalDineCharge +
        finalCardCharge +
        finalBankCharge
      ).toFixed(2)
    );


    // --------------------------------------------------
    // PAID AT ORDER VALIDATION
    // --------------------------------------------------

    let initialChangeAmount = 0;

    if (paymentTiming === 'PAID_AT_ORDER') {
      const normalizedMethod = String(paymentMethod || 'Cash');
      const paid = Number(Number(finalPaidAmount).toFixed(2));
      const due = Number(finalTotalAmount.toFixed(2));

      if (normalizedMethod === 'Cash') {
        if (paid < due - 0.05) {
          throw new Error('Paid amount cannot be less than total amount.');
        }
        initialChangeAmount = Number(
          Math.max(paid - due, 0).toFixed(2)
        );
      } else if (Math.abs(paid - due) > 0.05) {
        throw new Error(
          'Card, Bank and Other payments must match the exact total amount.'
        );
      }
    }


    // --------------------------------------------------
    // UPDATE TOTALS
    // --------------------------------------------------

   
    const updatedOrderResult =
  await client.query(
    `
        UPDATE orders
    SET
      subtotal = $1,
      discount_amount = $2,
      gst_amount = $3,
      tax_amount = $4,
      total_amount = $5,
      card_charge = $6,
      bank_charge = $7,
      delivery_charge = $14,
      dine_charge = $15,
      payment_status = $8::varchar,
      paid_amount = $9,
      change_amount = $13,
      payment_method = $12,
      paid_at = CASE WHEN $8::varchar = 'paid' THEN NOW() ELSE NULL END
    WHERE id = $10 AND restaurant_id = $11
    RETURNING *
    `,
    [
          
      calculated.subtotal.toFixed(2),
      calculated.discountAmount.toFixed(2),
      calculated.gstAmount.toFixed(2),
      calculated.taxAmount.toFixed(2),
      finalTotalAmount.toFixed(2),
      finalCardCharge.toFixed(2),
      finalBankCharge.toFixed(2),
      initialPaymentStatus,
      finalPaidAmount.toFixed(2),
      order.id,
      restaurantId,
      (initialPaymentStatus === 'paid'
        ? (paymentMethod || 'Cash')
        : null),
      initialChangeAmount.toFixed(2),
      finalDeliveryCharge.toFixed(2),
      finalDineCharge.toFixed(2)
    ]
  );
   


    // Record an immutable accounting event when the order was paid at creation.
    if (initialPaymentStatus === 'paid') {
      await client.query(
        `
        INSERT INTO payment_transactions
        (
          restaurant_id,
          order_id,
          amount,
          payment_method,
          status,
          actor_user_id,
          metadata
        )
        VALUES ($1, $2, $3, $4, 'completed', $5, $6::jsonb)
        `,
        [
          restaurantId,
          order.id,
          finalTotalAmount.toFixed(2),
          normalizedPaymentMethod,
          createdByUserId,
          JSON.stringify({
            source: 'paid_at_order',
            order_total: finalTotalAmount.toFixed(2),
            card_surcharge: finalCardCharge.toFixed(2),
            bank_surcharge: finalBankCharge.toFixed(2),
            tendered_amount: finalPaidAmount.toFixed(2),
            change_amount: initialChangeAmount.toFixed(2)
          })
        ]
      );
    }

    await client.query('COMMIT');


    return updatedOrderResult.rows[0];

  }

  catch (err) {

    await client.query(
      'ROLLBACK'
    );

    throw err;

  }

  finally {

    client.release();

  }

};


// ======================================================
// GET ALL ORDERS
// ======================================================

const getAllOrders = async (
  restaurantId
) => {

  const result =
    await pool.query(
      `
      SELECT

        o.*,

        rider.full_name AS delivery_rider_name,
        rider.username AS delivery_rider_username,

        COALESCE(
          (
            SELECT json_agg(row_to_json(item_rows))
            FROM (
              SELECT

                oi.id AS order_item_id,
                oi.menu_item_id,
                oi.variant_id,
                miv.label AS variant_label,
                m.name,
                oi.unit_price AS price,
                oi.quantity,
                oi.new_quantity,
                oi.line_total AS subtotal

              FROM order_items oi

              INNER JOIN menu_items m
                ON m.id = oi.menu_item_id

              LEFT JOIN menu_item_variants miv
                ON miv.id = oi.variant_id

              WHERE oi.order_id = o.id
                AND oi.order_deal_id IS NULL

            ) item_rows
          ),
          '[]'
        ) AS items,

        COALESCE(
          (
            SELECT json_agg(deal_rows)
            FROM (
              SELECT

                od.id AS order_deal_id,
                od.deal_id,
                d.name AS deal_name,
                d.type AS deal_type,
                od.quantity,
                od.unit_price AS price,
                od.line_total AS subtotal,

                COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'menu_item_id', oi2.menu_item_id,
                        'variant_id', oi2.variant_id,
                        'variant_label', miv2.label,
                        'name', m2.name,
                        'quantity', oi2.quantity,
                        'new_quantity', oi2.new_quantity
                      )
                    )
                    FROM order_items oi2

                    INNER JOIN menu_items m2
                      ON m2.id = oi2.menu_item_id

                    LEFT JOIN menu_item_variants miv2
                      ON miv2.id = oi2.variant_id

                    WHERE oi2.order_deal_id = od.id
                  ),
                  '[]'
                ) AS items

              FROM order_deals od

              INNER JOIN deals d
                ON d.id = od.deal_id

              WHERE od.order_id = o.id

            ) deal_rows
          ),
          '[]'
        ) AS deals,

        COALESCE(
          o.total_amount,
          0
        ) AS total

      FROM orders o

      LEFT JOIN users rider
        ON rider.id = o.delivery_rider_id
        AND rider.restaurant_id = o.restaurant_id
        AND rider.role = 'delivery'

      WHERE o.restaurant_id = $1

      ORDER BY
        o.created_at DESC
      `,
      [
        restaurantId
      ]
    );

  return result.rows;

};


// ======================================================
// ACCEPT ORDER
//
// MENU:
// pending → accepted
//
// WAITER / COUNTER / PHONE:
// accept is NOT required.
// ======================================================

const acceptOrder = async (
  id,
  restaurantId
) => {

  const result =
    await pool.query(
      `
      UPDATE orders

      SET
        status = 'accepted'

      WHERE id = $1

        AND restaurant_id = $2

        AND status = 'pending'

        AND order_source = 'MENU'

      RETURNING *
      `,
      [
        id,
        restaurantId
      ]
    );


  return result.rows[0] || null;

};


// ======================================================
// CONFIRM ORDER
//
// MENU:
// accepted → preparing
//
// WAITER / COUNTER / PHONE:
// placed → preparing
//
// confirmed is kept for old-data compatibility.
// ======================================================

const confirmOrder = async (
  id,
  prepMinutes,
  restaurantId
) => {

  prepMinutes =
    Number(prepMinutes);


  if (
    !Number.isInteger(prepMinutes) ||
    prepMinutes <= 0
  ) {

    throw new Error(
      'Prep time must be a positive whole number.'
    );

  }


  const result =
    await pool.query(
      `
      UPDATE orders

      SET

        status = 'preparing',

        prep_minutes = $1,

        confirmed_at = NOW()

      WHERE id = $2

        AND restaurant_id = $3

        AND status IN (
          'accepted',
          'placed',
          'confirmed'
        )

      RETURNING *
      `,
      [
        prepMinutes,
        id,
        restaurantId
      ]
    );


  if (result.rows.length) {

    await pool.query(
      `
      UPDATE order_items

      SET
        new_quantity = 0

      WHERE order_id = $1
      `,
      [
        id
      ]
    );

  }


  return result.rows[0] || null;

};


// ======================================================
// MARK READY
//
// NORMAL DINE-IN:
// preparing → ready
//
// DELIVERY:
// preparing → ready_to_deliver
// ======================================================

const markReady = async (
  id,
  restaurantId
) => {

  const result =
    await pool.query(
      `
      UPDATE orders

      SET

        status =
          CASE
            WHEN order_type = 'delivery' THEN 'ready_to_deliver'
            WHEN order_type = 'walk_in' THEN 'ready_to_dispatch'
            ELSE 'ready'
          END,

        ready_at = NOW()

      WHERE id = $1
        AND restaurant_id = $2
        AND status = 'preparing'              
      RETURNING *
      `,
      [
        id,
        restaurantId
      ]
    );

  return result.rows[0] || null;

};


// ======================================================
// MARK OUT FOR DELIVERY
//
// DELIVERY:
// ready_to_deliver → out_for_delivery
// ======================================================

const markOutForDelivery = async (
  id,
  restaurantId,
  riderId = null
) => {

  const result =
    await pool.query(
      `
      UPDATE orders

      SET

        status = 'out_for_delivery'

      WHERE id = $1

        AND restaurant_id = $2

        AND order_type = 'delivery'

        AND status = 'ready_to_deliver'

        AND delivery_rider_id IS NOT NULL
        AND ($3 IS NULL OR delivery_rider_id = $3)

      RETURNING *
      `,
      [
        id,
        restaurantId,
        riderId
      ]
    );


  return result.rows[0] || null;

};


// ======================================================
// MARK DELIVERED
//
// DELIVERY:
// out_for_delivery → delivered
//
// Delivery orders only.
// ======================================================

const markDelivered = async (
  id,
  restaurantId,
  riderId = null
) => {

  const result =
    await pool.query(
      `
      UPDATE orders

      SET

        status = 'delivered',

        delivered_at = NOW()

      WHERE id = $1

        AND restaurant_id = $2

        AND order_type = 'delivery'

        AND status = 'out_for_delivery'

        AND delivery_rider_id IS NOT NULL
        AND ($3 IS NULL OR delivery_rider_id = $3)

      RETURNING *
      `,
      [
        id,
        restaurantId,
        riderId
      ]
    );


  return result.rows[0] || null;

};


// ======================================================
// MARK COMPLETED
//
// DELIVERY:
// delivered → completed
//
// Delivery orders only.
// ======================================================

const markCompleted = async (id, restaurantId, riderId = null) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `SELECT plan FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    const isCafeLite = (planRes.rows[0]?.plan || '') === 'Cafe Lite';

    let orderResult;
    if (isCafeLite) {
      // Cafe Lite: single-screen POS — complete any non-cancelled paid/unpaid active order
      orderResult = await client.query(
        `SELECT *
         FROM orders
         WHERE id = $1
           AND restaurant_id = $2
           AND status NOT IN ('completed', 'cancelled')
           AND ($3 IS NULL OR delivery_rider_id = $3)
         FOR UPDATE`,
        [id, restaurantId, riderId]
      );
    } else {
      orderResult = await client.query(
        `SELECT *
         FROM orders
         WHERE id = $1
           AND restaurant_id = $2
           AND order_type = 'delivery'
           AND status = 'delivered'
           AND delivery_rider_id IS NOT NULL
           AND ($3 IS NULL OR delivery_rider_id = $3)
         FOR UPDATE`,
        [id, restaurantId, riderId]
      );
    }

    const order = orderResult.rows[0];
    if (!order) { await client.query('ROLLBACK'); return null; }

    // Cafe Lite: prefer paid orders for complete (counter flow)
    if (isCafeLite && order.payment_status !== 'paid') {
      await client.query('ROLLBACK');
      return null;
    }

    // Agar order 'served' nahi hua (jaise Pay Now), toh ab stock deduct karo
    if (order.status !== 'served') {
      await deductStockForOrder(client, order.id, restaurantId);
    }

    const result = await client.query(
      `UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
      [id, restaurantId]
    );
    
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};


// ======================================================
// MARK SERVED + INVENTORY
//
// ready → served
//
// INVENTORY IS DEDUCTED ONLY HERE.
// PAYMENT DOES NOT DEDUCT INVENTORY.
// ======================================================

const markServed = async (
  id,
  restaurantId
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    // --------------------------------------------------
    // LOCK READY ORDER
    // --------------------------------------------------

    const orderResult =
      await client.query(
        `
        SELECT *

        FROM orders

                WHERE id = $1
          AND restaurant_id = $2
          AND status IN ('ready', 'ready_to_dispatch')
        FOR UPDATE
        `,
        [
          id,
          restaurantId
        ]
      );


    if (!orderResult.rows.length) {

      await client.query('ROLLBACK');

      return null;

    }


    const order =
      orderResult.rows[0];


    // --------------------------------------------------
    // GET INGREDIENT REQUIREMENTS
    // --------------------------------------------------

    const ingredientsResult =
      await client.query(
        `
        SELECT

          mii.inventory_id,

          ii.name AS ingredient_name,

          ii.unit,

          mii.quantity AS recipe_quantity,

          oi.quantity AS order_quantity

        FROM order_items oi

        INNER JOIN menu_items mi
          ON mi.id = oi.menu_item_id

        INNER JOIN menu_item_ingredients mii
          ON mii.menu_item_id = mi.id
          AND (mii.variant_id IS NOT DISTINCT FROM oi.variant_id)

        INNER JOIN inventory_items ii
          ON ii.id = mii.inventory_id

        WHERE oi.order_id = $1

          AND mi.restaurant_id = $2

          AND ii.restaurant_id = $2
        `,
        [
          id,
          restaurantId
        ]
      );


    // --------------------------------------------------
    // CALCULATE REQUIRED STOCK
    // --------------------------------------------------

    const requiredStock = {};


    for (
      const row
      of ingredientsResult.rows
    ) {

      const inventoryId =
        row.inventory_id;


      const requiredQuantity =
        Number(row.recipe_quantity) *
        Number(row.order_quantity);


      if (!requiredStock[inventoryId]) {

        requiredStock[inventoryId] = {

          inventory_id:
            inventoryId,

          ingredient_name:
            row.ingredient_name,

          unit:
            row.unit,

          required_quantity:
            0

        };

      }


      requiredStock[inventoryId]
        .required_quantity +=
        requiredQuantity;

    }


    // --------------------------------------------------
    // CHECK KITCHEN STOCK
    // --------------------------------------------------

    for (
      const inventoryId
      of Object.keys(requiredStock)
    ) {

      const item =
        requiredStock[inventoryId];


      // ✅ Query kitchen_inventory instead of inventory_items
      const stockResult =
        await client.query(
          `
          SELECT
            ki.id,
            ki.quantity AS stock_quantity
          FROM kitchen_inventory ki
          WHERE ki.restaurant_id = $1
            AND ki.inventory_id = $2
          FOR UPDATE
          `,
          [
            restaurantId,
            item.inventory_id
          ]
        );


      if (!stockResult.rows.length) {

        await client.query('ROLLBACK');

        return {

          error:
            'KITCHEN_STOCK_NOT_FOUND',

          ingredient:
            item.ingredient_name

        };

      }


      const stock =
        Number(
          stockResult.rows[0].stock_quantity
        );


      if (
        stock <
        item.required_quantity
      ) {

        await client.query('ROLLBACK');

        return {

          error:
            'INSUFFICIENT_KITCHEN_STOCK',

          ingredient:
            item.ingredient_name,

          available:
            stock,

          required:
            item.required_quantity,

          unit:
            item.unit

        };

      }

    }


    // --------------------------------------------------
    // DEDUCT KITCHEN INVENTORY
    // --------------------------------------------------

    for (
      const inventoryId
      of Object.keys(requiredStock)
    ) {

      const item =
        requiredStock[inventoryId];

      // Get the kitchen inventory id for this item
      const kitchenItemResult =
        await client.query(
          `
          SELECT id
          FROM kitchen_inventory
          WHERE restaurant_id = $1
            AND inventory_id = $2
          `,
          [
            restaurantId,
            item.inventory_id
          ]
        );

      if (!kitchenItemResult.rows.length) {
        // Should not happen if we checked above, but just in case
        await client.query('ROLLBACK');
        return {
          error: 'KITCHEN_STOCK_NOT_FOUND',
          ingredient: item.ingredient_name
        };
      }

      const kitchenInventoryId =
        kitchenItemResult.rows[0].id;

      // Update kitchen inventory stock
      await client.query(
        `
        UPDATE kitchen_inventory

        SET
          quantity = quantity - $1,
          updated_at = NOW()

        WHERE id = $2
        `,
        [
          item.required_quantity,
          kitchenInventoryId
        ]
      );


      // Log in kitchen_inventory_transactions
      await client.query(
        `
        INSERT INTO kitchen_inventory_transactions
        (
          kitchen_inventory_id,
          type,
          quantity,
          note,
          order_id
        )

        VALUES
        (
          $1,
          'OUT',
          $2,
          $3,
          $4
        )
        `,
        [
          kitchenInventoryId,
          item.required_quantity,
          `Order #${order.id} served`,
          order.id
        ]
      );

    }


    // --------------------------------------------------
    // Mark physical stock consumption as complete.
    // markServed locks the order, so this is atomic with the deduction.
    // --------------------------------------------------

    await client.query(
      `UPDATE orders
       SET inventory_deducted_at = COALESCE(inventory_deducted_at, NOW())
       WHERE id = $1
         AND restaurant_id = $2`,
      [order.id, restaurantId]
    );

    // --------------------------------------------------
    // CONSUME INVENTORY RESERVATIONS (still relevant)
    // --------------------------------------------------

    await client.query(
      `
      UPDATE inventory_reservations

      SET
        status = 'consumed'

      WHERE order_id = $1
        AND restaurant_id = $2
        AND status = 'reserved'
      `,
      [
        order.id,
        restaurantId
      ]
    );



    // --------------------------------------------------
    // READY → SERVED
    // --------------------------------------------------

    const result =
      await client.query(
        `
        UPDATE orders

        SET

          status = 'served',

          served_at = NOW()

        WHERE id = $1

          AND restaurant_id = $2

          AND status IN ('ready', 'ready_to_dispatch')

        RETURNING *
        `,
        [
          id,
          restaurantId
        ]
      );


    await client.query('COMMIT');


    return result.rows[0] || null;

  }

  catch (err) {

    try {
      await client.query('ROLLBACK');
    }
    catch (_) {}

    throw err;

  }

  finally {

    client.release();

  }

};

// ======================================================
// MARK WALK-IN HANDED OVER
//
// ready_to_dispatch → completed (paid) ya served (unpaid)
//
// - Sirf walk-in orders
// - Sirf counter role se call hoga
// - Inventory yahin deduct hoti hai
// - Agar paid hai → direct completed
// - Agar unpaid hai → served (phir counter payment collect karega)
// ======================================================

const markWalkInHandedOver = async (
  id,
  restaurantId
) => {

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // --------------------------------------------------
    // LOCK ORDER
    // --------------------------------------------------

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
        AND restaurant_id = $2
        AND order_type = 'walk_in'
        AND status = 'ready_to_dispatch'
      FOR UPDATE
      `,
      [id, restaurantId]
    );

    if (!orderResult.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const order = orderResult.rows[0];

    // --------------------------------------------------
    // GET INGREDIENT REQUIREMENTS
    // --------------------------------------------------

    const ingredientsResult = await client.query(
      `
      SELECT
        mii.inventory_id,
        ii.name AS ingredient_name,
        ii.unit,
        mii.quantity AS recipe_quantity,
        oi.quantity AS order_quantity
      FROM order_items oi
      INNER JOIN menu_items mi
        ON mi.id = oi.menu_item_id
      INNER JOIN menu_item_ingredients mii
        ON mii.menu_item_id = mi.id
        AND (mii.variant_id IS NOT DISTINCT FROM oi.variant_id)
      INNER JOIN inventory_items ii
        ON ii.id = mii.inventory_id
      WHERE oi.order_id = $1
        AND mi.restaurant_id = $2
        AND ii.restaurant_id = $2
      `,
      [id, restaurantId]
    );

    // --------------------------------------------------
    // CALCULATE REQUIRED STOCK
    // --------------------------------------------------

    const requiredStock = {};

    for (const row of ingredientsResult.rows) {
      const inventoryId = row.inventory_id;
      const requiredQuantity =
        Number(row.recipe_quantity) * Number(row.order_quantity);

      if (!requiredStock[inventoryId]) {
        requiredStock[inventoryId] = {
          inventory_id: inventoryId,
          ingredient_name: row.ingredient_name,
          unit: row.unit,
          required_quantity: 0
        };
      }

      requiredStock[inventoryId].required_quantity += requiredQuantity;
    }

    // --------------------------------------------------
    // CHECK + DEDUCT KITCHEN INVENTORY
    // --------------------------------------------------

    for (const inventoryId of Object.keys(requiredStock)) {
      const item = requiredStock[inventoryId];

      const stockResult = await client.query(
        `
        SELECT id, quantity AS stock_quantity
        FROM kitchen_inventory
        WHERE restaurant_id = $1
          AND inventory_id = $2
        FOR UPDATE
        `,
        [restaurantId, item.inventory_id]
      );

      if (!stockResult.rows.length) {
        await client.query('ROLLBACK');
        return {
          error: 'KITCHEN_STOCK_NOT_FOUND',
          ingredient: item.ingredient_name
        };
      }

      const stock = Number(stockResult.rows[0].stock_quantity);

      if (stock < item.required_quantity) {
        await client.query('ROLLBACK');
        return {
          error: 'INSUFFICIENT_KITCHEN_STOCK',
          ingredient: item.ingredient_name,
          available: stock,
          required: item.required_quantity,
          unit: item.unit
        };
      }

      const kitchenInventoryId = stockResult.rows[0].id;

      await client.query(
        `
        UPDATE kitchen_inventory
        SET quantity = quantity - $1, updated_at = NOW()
        WHERE id = $2
        `,
        [item.required_quantity, kitchenInventoryId]
      );

      await client.query(
        `
        INSERT INTO kitchen_inventory_transactions
        (kitchen_inventory_id, type, quantity, note, order_id)
        VALUES ($1, 'OUT', $2, $3, $4)
        `,
        [
          kitchenInventoryId,
          item.required_quantity,
          `Walk-in order #${order.id} handed over`,
          order.id
        ]
      );
    }

    // Record physical consumption in this transaction. Without this marker,
    // Cafe Lite completion can deduct an unpaid walk-in order a second time.
    await client.query(
      `UPDATE orders
       SET inventory_deducted_at = COALESCE(inventory_deducted_at, NOW())
       WHERE id = $1 AND restaurant_id = $2`,
      [order.id, restaurantId]
    );

    // Consume only this restaurant's reservations.
    await client.query(
      `
      UPDATE inventory_reservations
      SET status = 'consumed',
          released_at = NULL
      WHERE order_id = $1
        AND restaurant_id = $2
        AND status = 'reserved'
      `,
      [order.id, restaurantId]
    );

    // --------------------------------------------------
    // DETERMINE FINAL STATUS
    //
    // paid   → completed
    // unpaid → served (counter phir payment collect karega)
    // --------------------------------------------------

    const wasPaid = String(order.payment_status).toLowerCase() === 'paid';
    const newStatus = wasPaid ? 'completed' : 'served';

       const completedAt = wasPaid ? new Date() : null;

    const result = await client.query(
      `
      UPDATE orders
      SET
        status = $1::varchar,
        served_at = NOW(),
        completed_at = $2
      WHERE id = $3
        AND restaurant_id = $4
      RETURNING *
      `,
      [newStatus, completedAt, id, restaurantId]
    );

    await client.query('COMMIT');

    return result.rows[0] || null;

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

};

// ======================================================
// UPDATE ORDER PRICING
//
// SERVED + UNPAID ONLY
// ======================================================

const updateOrderPricing = async (
  id,
  restaurantId,
  pricing
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


        const orderResult =
      await client.query(
        `
        SELECT
          id,
          subtotal,
          status,
          payment_status,
          paid_amount,
          order_type,
          card_charge,
          bank_charge
        FROM orders
        WHERE id = $1
          AND restaurant_id = $2
        FOR UPDATE
        `,
        [id, restaurantId]
      );


    if (!orderResult.rows.length) {

      await client.query('ROLLBACK');

      return null;

    }


    const order =
      orderResult.rows[0];


    // --------------------------------------------------
    // ONLY SERVED + UNPAID
    // --------------------------------------------------

    if (
      order.payment_status !== 'unpaid' ||
      !['served', 'placed', 'preparing', 'ready', 'payment_pending'].includes(
        String(order.status || '').toLowerCase()
      )
    ) {

      await client.query('ROLLBACK');

      return null;

    }

    const chargeResult = await client.query(
      `SELECT
         COALESCE(NULLIF(pos_settings->>'delivery_charge','')::numeric, delivery_charge, 0) AS delivery_charge,
         COALESCE(NULLIF(pos_settings->>'dine_charge','')::numeric, dine_charge, 0) AS dine_charge
       FROM restaurants
       WHERE id = $1
       FOR SHARE`,
      [restaurantId]
    );

    if (!chargeResult.rows.length) {
      throw new Error('Restaurant not found.');
    }

    const configuredDeliveryCharge = Number(chargeResult.rows[0].delivery_charge || 0);
    const configuredDineCharge = Number(chargeResult.rows[0].dine_charge || 0);

    if (
      !Number.isFinite(configuredDeliveryCharge) ||
      configuredDeliveryCharge < 0 ||
      !Number.isFinite(configuredDineCharge) ||
      configuredDineCharge < 0
    ) {
      throw new Error('Invalid restaurant charge configuration.');
    }

    const deliveryCharge = order.order_type === 'delivery'
      ? configuredDeliveryCharge
      : 0;
    const dineCharge = order.order_type === 'dine_in'
      ? configuredDineCharge
      : 0;


    const discountType =
      pricing.discount_type || 'none';

    const discountValue =
      Number(pricing.discount_value || 0);

    const gstPercent =
      Number(pricing.gst_percent || 0);

    const taxPercent =
      Number(pricing.tax_percent || 0);


    if (
      !['none', 'percent', 'fixed']
        .includes(discountType)
    ) {

      throw new Error(
        'Invalid discount type.'
      );

    }


    if (
      !Number.isFinite(discountValue) ||
      !Number.isFinite(gstPercent) ||
      !Number.isFinite(taxPercent)
    ) {

      throw new Error(
        'Pricing values must be valid numbers.'
      );

    }


    if (
      discountValue < 0 ||
      gstPercent < 0 ||
      taxPercent < 0
    ) {

      throw new Error(
        'Pricing values cannot be negative.'
      );

    }


    if (
      discountType === 'percent' &&
      discountValue > 100
    ) {

      throw new Error(
        'Percentage discount cannot exceed 100%.'
      );

    }


    if (gstPercent > 100) {

      throw new Error(
        'GST percentage cannot exceed 100%.'
      );

    }


    if (taxPercent > 100) {

      throw new Error(
        'Tax percentage cannot exceed 100%.'
      );

    }


        const subtotalResult =
      await client.query(
        `
        SELECT

          COALESCE(
            SUM(
              (oi.unit_price::numeric * oi.quantity::numeric)
            ),
            0
          ) AS subtotal

        FROM order_items oi

        INNER JOIN menu_items m
          ON m.id = oi.menu_item_id

        LEFT JOIN menu_item_variants miv
          ON miv.id = oi.variant_id

        WHERE oi.order_id = $1

          AND m.restaurant_id = $2

          AND oi.order_deal_id IS NULL
        `,
        [
          id,
          restaurantId
        ]
      );


    const dealsSubtotalResult =
      await client.query(
        `
        SELECT

          COALESCE(
            SUM(od.line_total),
            0
          ) AS subtotal

        FROM order_deals od

        INNER JOIN deals d
          ON d.id = od.deal_id

        WHERE od.order_id = $1

          AND d.restaurant_id = $2
        `,
        [
          id,
          restaurantId
        ]
      );


    const subtotal =
      Number(
        subtotalResult.rows[0].subtotal || 0
      ) +
      Number(
        dealsSubtotalResult.rows[0].subtotal || 0
      );


    const calculated =
      calculatePricing(
        subtotal,
        discountType,
        discountValue,
        gstPercent,
        taxPercent
      );

      const existingCardCharge = Number(order.card_charge || 0);
      const existingBankCharge = Number(order.bank_charge || 0);
      const finalTotal = calculated.totalAmount + deliveryCharge + dineCharge + existingCardCharge + existingBankCharge;


    const result = await client.query(
  `
  UPDATE orders
  SET
    discount_type = $1,
    discount_value = $2,
    gst_percent = $3,
    tax_percent = $4,
    delivery_charge = $5,     
    dine_charge = $6,         
    subtotal = $7,
    discount_amount = $8,
    gst_amount = $9,
    tax_amount = $10,
    total_amount = $11
  WHERE id = $12
    AND restaurant_id = $13
    AND payment_status = 'unpaid'
AND status IN ('served', 'placed', 'preparing', 'ready', 'payment_pending')
  RETURNING *
  `,
  [
    discountType,
    discountValue.toFixed(2),
    gstPercent.toFixed(2),
    taxPercent.toFixed(2),
    deliveryCharge.toFixed(2),  
    dineCharge.toFixed(2),       
    calculated.subtotal.toFixed(2),
    calculated.discountAmount.toFixed(2),
    calculated.gstAmount.toFixed(2),
    calculated.taxAmount.toFixed(2),
    finalTotal.toFixed(2),      
    id,
    restaurantId
  ]
);


    await client.query('COMMIT');


    return result.rows[0] || null;

  }

  catch (err) {

    try {
      await client.query('ROLLBACK');
    }
    catch (_) {}

    throw err;

  }

  finally {

    client.release();

  }

};


// ======================================================
// MARK PAID
//
// SERVED + UNPAID
//       ↓
// PAID
//
// Payment does NOT deduct inventory.
// Inventory is already deducted at SERVED.
// ======================================================

const markPaid = async (
  id,
  restaurantId,
  paymentMethod = 'Cash',
  paidAmount = null,
  paidByUserId = null
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    // ==================================================
    // GET + LOCK ORDER
    // ==================================================

    const orderResult =
      await client.query(
        `
        SELECT

          id,
          total_amount,
          paid_amount,
          status,
          payment_status,
          order_type

        FROM orders

        WHERE id = $1
          AND restaurant_id = $2

        FOR UPDATE
        `,
        [
          id,
          restaurantId
        ]
      );


    if (!orderResult.rows.length) {

      await client.query('ROLLBACK');

      return null;

    }


    const order =
      orderResult.rows[0];


    // ==================================================
    // PAYMENT STATUS VALIDATION
    //
    // DINE-IN:
    // served / payment_pending → paid
    //
    // DELIVERY:
    // delivered → paid
    // ==================================================

   // Cafe Lite: unpaid orders stay in 'placed' — allow pay from placed too
   const planPay = await client.query(
     `SELECT plan FROM restaurants WHERE id = $1`,
     [restaurantId]
   );
   const isCafeLitePay = (planPay.rows[0]?.plan || '') === 'Cafe Lite';
   const allowedStatuses = isCafeLitePay
     ? ['placed', 'served', 'payment_pending', 'delivered', 'completed', 'preparing', 'ready', 'ready_to_dispatch']
     : ['served', 'payment_pending', 'delivered', 'completed'];

if (!allowedStatuses.includes(order.status)) {
  await client.query('ROLLBACK');
  return null;
}

    // ==================================================
    // ALREADY PAID
    // ==================================================

    if (
      order.payment_status === 'paid'
    ) {

      await client.query('ROLLBACK');

      return null;

    }


    // ==================================================
    // PAYMENT METHOD
    // ==================================================

    const allowedPaymentMethods = [
      'Cash',
      'Card',
      'Bank',
      'Other'
    ];


    if (
      !allowedPaymentMethods.includes(
        paymentMethod
      )
    ) {

      throw new Error(
        'Invalid payment method.'
      );

    }


    // ==================================================
    // SERVER-SIDE PAYMENT SURCHARGE
    //
    // Request-supplied card_charge / bank_charge are NOT trusted.
    // Restaurant settings contain the surcharge percentage.
    // ==================================================

    const surchargeResult = await client.query(
      `SELECT
         COALESCE(NULLIF(pos_settings->>'card_charge','')::numeric, card_charge, 0) AS card_charge,
         COALESCE(NULLIF(pos_settings->>'bank_charge','')::numeric, bank_charge, 0) AS bank_charge
       FROM restaurants
       WHERE id = $1`,
      [restaurantId]
    );

    if (!surchargeResult.rows.length) {
      throw new Error('Restaurant not found.');
    }

    const configuredCardPercent =
      Number(surchargeResult.rows[0].card_charge || 0);

    const configuredBankPercent =
      Number(surchargeResult.rows[0].bank_charge || 0);

    if (
      !Number.isFinite(configuredCardPercent) ||
      configuredCardPercent < 0 ||
      configuredCardPercent > 100 ||
      !Number.isFinite(configuredBankPercent) ||
      configuredBankPercent < 0 ||
      configuredBankPercent > 100
    ) {
      throw new Error('Invalid restaurant payment surcharge configuration.');
    }

    // ==================================================
    // PAID AMOUNT
    // ==================================================

    let finalPaidAmount;


    if (
      paidAmount === null ||
      paidAmount === undefined ||
      paidAmount === ''
    ) {

      finalPaidAmount =
        Number(
          order.total_amount || 0
        );

    }

    else {

      finalPaidAmount =
        Number(paidAmount);

    }


    if (
      !Number.isFinite(
        finalPaidAmount
      ) ||
      finalPaidAmount < 0
    ) {

      throw new Error(
        'Invalid paid amount.'
      );

    }
    // ==================================================
    // TOTAL AMOUNT + PAYMENT SURCHARGES
    // ==================================================

    const totalAmount =
      Number(
        order.total_amount || 0
      );

    // Surcharge is selected from the payment method and calculated
    // from the server-side restaurant percentage.
    let addCard = 0;
    let addBank = 0;

    if (paymentMethod === 'Card') {
      addCard = Number(
        (totalAmount * configuredCardPercent / 100).toFixed(2)
      );
    } else if (paymentMethod === 'Bank') {
      addBank = Number(
        (totalAmount * configuredBankPercent / 100).toFixed(2)
      );
    }

    const newTotalAmount = Number(
      (totalAmount + addCard + addBank).toFixed(2)
    );

    // If the caller did not specify a paid amount, default to the
    // complete server-calculated amount, including surcharge.
    if (
      paidAmount === null ||
      paidAmount === undefined ||
      paidAmount === ''
    ) {
      finalPaidAmount = newTotalAmount;
    }

    // Non-cash payments must settle the exact server-calculated amount.
    // Cash may exceed the bill; the excess is recorded as customer change.
    const changeAmount = paymentMethod === 'Cash'
      ? Number(Math.max(finalPaidAmount - newTotalAmount, 0).toFixed(2))
      : 0;

    const paidRounded = Number(Number(finalPaidAmount).toFixed(2));
    const dueRounded = Number(Number(newTotalAmount).toFixed(2));

    if (
      paymentMethod !== 'Cash' &&
      Math.abs(paidRounded - dueRounded) > 0.05
    ) {
      throw new Error(
        'Card, Bank and Other payments must match the exact total amount.'
      );
    }

    if (paymentMethod === 'Cash' && paidRounded < dueRounded - 0.05) {
      throw new Error(
        'Paid amount cannot be less than total amount.'
      );
    }


    // ==================================================
    // MARK PAID
    // ==================================================

    // Cafe Lite: allow pay while order is still 'placed' (no kitchen/serve step)
    const statusList = isCafeLitePay
      ? ['placed', 'served', 'payment_pending', 'delivered', 'preparing', 'ready', 'ready_to_dispatch']
      : ['served', 'payment_pending', 'delivered'];

    const result =
      await client.query(
        `
        UPDATE orders
        SET
          payment_status = 'paid',
          payment_method = $3,
          paid_amount = $4,
          change_amount = $5,
          paid_at = NOW(),
          paid_by_user_id = $6,
          card_charge = $7,
          bank_charge = $8,
          total_amount = $9
        WHERE id = $1
          AND restaurant_id = $2
          AND status = ANY($10::text[])
          AND payment_status = 'unpaid'
        RETURNING *
        `,
        [
          id,
          restaurantId,
          paymentMethod,
          finalPaidAmount.toFixed(2),
          changeAmount.toFixed(2),
          paidByUserId,
          addCard.toFixed(2),
          addBank.toFixed(2),
          newTotalAmount.toFixed(2),
          statusList
        ]
      );


    if (
      result.rows.length === 0
    ) {

      await client.query('ROLLBACK');

      return null;

    }

    // Immutable payment ledger entry.
    // The order row remains the current payment state; this record is the
    // append-only accounting event for the successful settlement.
    await client.query(
      `
      INSERT INTO payment_transactions
      (
        restaurant_id,
        order_id,
        amount,
        payment_method,
        status,
        actor_user_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, 'completed', $5, $6::jsonb)
      `,
      [
        restaurantId,
        id,
        newTotalAmount.toFixed(2),
        paymentMethod,
        paidByUserId,
        JSON.stringify({
          source: 'staff_payment',
          order_total: newTotalAmount.toFixed(2),
          card_surcharge: addCard.toFixed(2),
          bank_surcharge: addBank.toFixed(2),
          tendered_amount: finalPaidAmount.toFixed(2),
          change_amount: changeAmount.toFixed(2)
        })
      ]
    );


    await client.query('COMMIT');


    return result.rows[0];

  }
  catch (err) {

    await client.query('ROLLBACK');

    throw err;

  }
  finally {

    client.release();

  }

};


// ======================================================
// GET ACTIVE ORDER FOR TABLE
//
// Active order means table still has
// an unfinished order.
// ======================================================

const getActiveOrderForTable = async (tableNo, restaurantId) => {
  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE table_no = $1
      AND restaurant_id = $2
      AND status IN (
        'pending',
        'placed',
        'accepted',
        'preparing',
        'ready',
        'ready_to_dispatch'
      )
      AND payment_status != 'paid'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [tableNo, restaurantId]
  );
  return result.rows[0] || null;
};


// ======================================================
// ADD ITEMS TO EXISTING ORDER
// ======================================================


// ======================================================
// ADJUST SERVED-ORDER INVENTORY
//
// Served unpaid bills may be edited by manager/counter.
// At that point the original recipe stock has already been
// consumed, so editing the bill must apply only the delta
// between the old and new recipe requirements.
// ======================================================

const adjustServedOrderInventory = async (
  client,
  orderId,
  restaurantId,
  beforeItems
) => {
  const afterResult = await client.query(
    `
    SELECT menu_item_id, variant_id, quantity
    FROM order_items
    WHERE order_id = $1
    `,
    [orderId]
  );

  const calculateRequirements = async (items) => {
    const totals = {};

    for (const item of items || []) {
      const recipeResult = await client.query(
        `
        SELECT mii.inventory_id, mii.quantity
        FROM menu_item_ingredients mii
        INNER JOIN inventory_items ii
          ON ii.id = mii.inventory_id
        INNER JOIN menu_items mi
          ON mi.id = mii.menu_item_id
        WHERE mii.menu_item_id = $1
          AND mii.variant_id IS NOT DISTINCT FROM $2
          AND ii.restaurant_id = $3
          AND mi.restaurant_id = $3
        `,
        [item.menu_item_id, item.variant_id ?? null, restaurantId]
      );

      for (const recipe of recipeResult.rows) {
        const required =
          Number(recipe.quantity || 0) * Number(item.quantity || 0);

        if (!Number.isFinite(required) || required < 0) {
          throw new Error('Invalid recipe quantity.');
        }

        const inventoryId = Number(recipe.inventory_id);
        totals[inventoryId] = (totals[inventoryId] || 0) + required;
      }
    }

    return totals;
  };

  const beforeTotals = await calculateRequirements(beforeItems);
  const afterTotals = await calculateRequirements(afterResult.rows);

  const inventoryIds = new Set([
    ...Object.keys(beforeTotals),
    ...Object.keys(afterTotals)
  ]);

  for (const inventoryId of inventoryIds) {
    const beforeQty = Number(beforeTotals[inventoryId] || 0);
    const afterQty = Number(afterTotals[inventoryId] || 0);
    const delta = afterQty - beforeQty;

    if (delta === 0) continue;

    const stockResult = await client.query(
      `
      SELECT ki.id, ki.quantity, ii.name, ii.unit
      FROM kitchen_inventory ki
      INNER JOIN inventory_items ii ON ii.id = ki.inventory_id
      WHERE ki.restaurant_id = $1
        AND ki.inventory_id = $2
      FOR UPDATE
      `,
      [restaurantId, Number(inventoryId)]
    );

    if (!stockResult.rowCount) {
      throw new Error(`Kitchen inventory not found for inventory item ${inventoryId}.`);
    }

    const kitchenInventory = stockResult.rows[0];
    const currentStock = Number(kitchenInventory.quantity || 0);

    if (!Number.isFinite(currentStock) || currentStock < 0) {
      throw new Error(`Invalid kitchen stock for "${kitchenInventory.name}".`);
    }

    if (delta > 0 && currentStock < delta) {
      const err = new Error(
        `Insufficient kitchen stock for "${kitchenInventory.name}". Available: ${currentStock} ${kitchenInventory.unit}, Required: ${delta} ${kitchenInventory.unit}.`
      );
      err.error = 'INSUFFICIENT_KITCHEN_STOCK';
      err.ingredient = kitchenInventory.name;
      err.available = currentStock;
      err.required = delta;
      err.unit = kitchenInventory.unit;
      throw err;
    }

    const nextStock = currentStock - delta;

    await client.query(
      `
      UPDATE kitchen_inventory
      SET quantity = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [nextStock, kitchenInventory.id]
    );

    await client.query(
      `
      INSERT INTO kitchen_inventory_transactions
      (kitchen_inventory_id, type, quantity, note, order_id)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        kitchenInventory.id,
        delta > 0 ? 'OUT' : 'IN',
        Math.abs(delta),
        delta > 0
          ? `Order #${orderId} served-bill edit: additional consumption`
          : `Order #${orderId} served-bill edit: stock restored`,
        orderId
      ]
    );
  }
};

const addItemsToOrder = async (
  orderId,
  items,
  restaurantId,
  role = 'waiter',
  deals = []
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    const orderResult =
      await client.query(
        `
        SELECT

          id,

          status,

          payment_status,

          discount_type,

          discount_value,

          gst_percent,

          tax_percent,

          order_type,

          order_source

        FROM orders

        WHERE id = $1

          AND restaurant_id = $2

        FOR UPDATE
        `,
        [
          orderId,
          restaurantId
        ]
      );


    if (!orderResult.rows.length) {

      throw new Error(
        'Order not found.'
      );

    }


    const order =
      orderResult.rows[0];

    const beforeItemsResult = await client.query(
      `SELECT menu_item_id, variant_id, quantity FROM order_items WHERE order_id = $1`,
      [order.id]
    );
    const beforeItems = beforeItemsResult.rows;


    // --------------------------------------------------
    // MANAGER / COUNTER
    // --------------------------------------------------


         // ==================================================
    // ROLE-BASED AUTHORIZATION (UPDATED)
    // ==================================================

    if (role === 'counter') {
      // Counter can add items to:
      // 1. Active orders (pending, placed, accepted, preparing)
      // 2. Served + unpaid (bill editing)
      const allowedActiveStatuses = ['pending', 'placed', 'accepted', 'preparing'];
      const allowedServedStatuses = ['served'];

      if (allowedActiveStatuses.includes(order.status)) {
        // Active order — allowed
      } else if (allowedServedStatuses.includes(order.status) && order.payment_status === 'unpaid') {
        // Served unpaid — allowed (bill edit)
      } else {
        throw new Error('Counter can only add items to active orders or served unpaid bills.');
      }
    } else if (role === 'manager') {
      if (order.status !== 'served' || order.payment_status !== 'unpaid') {
        throw new Error('Only served unpaid orders can be edited by manager.');
      }
    } else if (role === 'waiter') {
      if (['served', 'completed', 'cancelled'].includes(order.status)) {
        throw new Error('Cannot add items to completed or served orders.');
      }
    } else {
      throw new Error('Unauthorized');
    }



    // --------------------------------------------------
    // ADD ITEMS
    // --------------------------------------------------

    for (const item of items) {

      const variantId =
        item.variant_id === undefined ||
        item.variant_id === null ||
        item.variant_id === ''
          ? null
          : Number(item.variant_id);

      if (
        !Number.isInteger(item.menu_item_id) ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0 ||
        (
          variantId !== null &&
          (!Number.isInteger(variantId) || variantId <= 0)
        )
      ) {

        throw new Error(
          'Invalid order item.'
        );

      }


      const menuCheck =
        await client.query(
          `
          SELECT id, price

          FROM menu_items

          WHERE id = $1

            AND restaurant_id = $2
          `,
          [
            item.menu_item_id,
            restaurantId
          ]
        );


      if (!menuCheck.rowCount) {

        throw new Error(
          `Menu item ${item.menu_item_id} not found.`
        );

      }


      let unitPrice = Number(menuCheck.rows[0].price);

      if (variantId !== null) {

        const variantCheck =
          await client.query(
            `
            SELECT id, price

            FROM menu_item_variants

            WHERE id = $1

              AND menu_item_id = $2

              AND active = true
            `,
            [
              variantId,
              item.menu_item_id
            ]
          );

        if (!variantCheck.rowCount) {

          throw new Error(
            `Size/pieces option for menu item ${item.menu_item_id} not found.`
          );

        }

        unitPrice = Number(variantCheck.rows[0].price);

      }


      const existing =
        await client.query(
          `
          SELECT id

          FROM order_items

          WHERE order_id = $1

            AND menu_item_id = $2

            AND variant_id IS NOT DISTINCT FROM $3
          `,
          [
            orderId,
            item.menu_item_id,
            variantId
          ]
        );


      if (existing.rowCount) {

        await client.query(
          `

          UPDATE order_items

SET

  quantity =
    quantity + $1,

  new_quantity =
    new_quantity + $1,

  line_total =
    (quantity + $1) * unit_price

WHERE id = $2
          `,
          [
            item.quantity,
            existing.rows[0].id
          ]
        );

      }

      else {

        await client.query(
          `
          INSERT INTO order_items
          (
            order_id,
            menu_item_id,
            variant_id,
            quantity,
            new_quantity,
            unit_price,
            line_total
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          )
          `,
          [
            orderId,
            item.menu_item_id,
            variantId,
            item.quantity,
            item.quantity,
            unitPrice,
            Number(item.quantity) * Number(unitPrice)
          ]
        );

      }

    }


    // --------------------------------------------------
    // WAITER ADD ITEM
    //
    // Existing active order goes back to pending.
    // --------------------------------------------------

    if (
  role !== 'manager' &&
  role !== 'counter'
) {

  await client.query(
    `
    UPDATE orders

    SET

      status =
        CASE
          WHEN order_source = 'MENU'
            THEN 'pending'
          ELSE 'placed'
        END,

      confirmed_at = NULL,

      prep_minutes = NULL,

      ready_at = NULL

    WHERE id = $1

      AND restaurant_id = $2
    `,
    [
      orderId,
      restaurantId
    ]
  );

}


    // --------------------------------------------------
    // ADD DEALS TO EXISTING ORDER
    // --------------------------------------------------

    if (Array.isArray(deals) && deals.length) {

      for (const deal of deals) {

        const dealId = Number(deal.deal_id);
        const dealQuantity = Number(deal.quantity);

        if (
          !Number.isInteger(dealId) ||
          dealId <= 0 ||
          !Number.isInteger(dealQuantity) ||
          dealQuantity <= 0
        ) {

          throw new Error(
            'Invalid deal or quantity.'
          );

        }


        const dealCheck =
          await client.query(
            `
            SELECT id

            FROM deals

            WHERE id = $1

              AND restaurant_id = $2

              AND active = true
            `,
            [
              dealId,
              restaurantId
            ]
          );


        if (!dealCheck.rowCount) {

          throw new Error(
            `Deal ${dealId} not found.`
          );

        }


        const orderDealResult =
          await client.query(
            `
            INSERT INTO order_deals
            (
              order_id,
              deal_id,
              quantity,
              unit_price,
              line_total
            )

            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5
            )

            RETURNING id
            `,
            [
              orderId,
              dealId,
              dealQuantity,
              Number(dealCheck.rows[0].price),
              Number(dealQuantity) * Number(dealCheck.rows[0].price)
            ]
          );


        const orderDealId =
          orderDealResult.rows[0].id;


        const dealItemsResult =
          await client.query(
            `
            SELECT

              menu_item_id,

              variant_id,

              quantity

            FROM deal_items

            WHERE deal_id = $1
            `,
            [
              dealId
            ]
          );


                  for (const dealItem of dealItemsResult.rows) {
            const qty = dealItem.quantity * dealQuantity;

            const dealItemPriceResult = await client.query(
              `SELECT COALESCE(miv.price, m.price) AS price
               FROM menu_items m
               LEFT JOIN menu_item_variants miv
                 ON miv.id = $2 AND miv.menu_item_id = m.id
               WHERE m.id = $1 AND m.restaurant_id = $3`,
              [dealItem.menu_item_id, dealItem.variant_id, restaurantId]
            );

            if (!dealItemPriceResult.rowCount) {
              throw new Error(`Deal menu item ${dealItem.menu_item_id} not found.`);
            }

            const dealItemUnitPrice = Number(dealItemPriceResult.rows[0].price);

            await client.query(
              `
              INSERT INTO order_items
              (
                order_id,
                menu_item_id,
                variant_id,
                quantity,
                new_quantity,
                order_deal_id,
                unit_price,
                line_total
              )
              VALUES
              (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8
              )
              `,
              [
                orderId,
                dealItem.menu_item_id,
                dealItem.variant_id,
                qty,
                qty,
                orderDealId,
                dealItemUnitPrice,
                Number(qty) * Number(dealItemUnitPrice)
              ]
            );
          }

      }

    }


    await recalculateOrderPricing(
  client,
  orderId,
  restaurantId
);


// --------------------------------------------------
// SYNC INVENTORY RESERVATION
//
// Only active waiter orders have an active reservation.
// Manager/counter edits happen after serving,
// where the reservation has already been consumed.
// --------------------------------------------------

if (order.status === 'served' && order.payment_status === 'unpaid') {

  await adjustServedOrderInventory(
    client,
    orderId,
    restaurantId,
    beforeItems
  );

} else {

  // Active orders must keep their reservation in sync,
  // including counter edits.
  await syncOrderInventoryReservation(
    client,
    orderId,
    restaurantId
  );

}


await client.query('COMMIT');

  }

  catch (err) {

    try {
      await client.query('ROLLBACK');
    }
    catch (_) {}

    throw err;

  }

  finally {

    client.release();

  }

};


// ======================================================
// UPDATE ORDER ITEM QUANTITY
// ======================================================

const updateOrderItemQuantity = async (
  orderItemId,
  quantity,
  restaurantId,
  role = 'waiter'
) => {

  quantity = Number(quantity);


  if (quantity <= 0) {

    return await removeOrderItem(
      orderItemId,
      restaurantId,
      role
    );

  }


  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    const orderCheck =
      await client.query(
        `
        SELECT

          o.id,

          o.status,

          o.payment_status,

          o.order_source

        FROM order_items oi

        INNER JOIN orders o
          ON o.id = oi.order_id

        WHERE oi.id = $1

          AND o.restaurant_id = $2

        FOR UPDATE
        `,
        [
          orderItemId,
          restaurantId
        ]
      );


    if (!orderCheck.rows.length) {

      await client.query('ROLLBACK');

      return null;

    }


    const order =
      orderCheck.rows[0];

    const beforeItemsResult = await client.query(
      `SELECT menu_item_id, variant_id, quantity FROM order_items WHERE order_id = $1`,
      [order.id]
    );
    const beforeItems = beforeItemsResult.rows;


    // ==================================================
    // ROLE-BASED AUTHORIZATION (UPDATED FOR COUNTER)
    // ==================================================

    if (role === 'counter') {
      const allowedActiveStatuses = ['pending', 'placed', 'accepted', 'preparing'];
      const allowedServedStatuses = ['served'];

      if (allowedActiveStatuses.includes(order.status)) {
        // ✅ Active order — allowed
      } else if (allowedServedStatuses.includes(order.status) && order.payment_status === 'unpaid') {
        // ✅ Served unpaid — allowed (bill edit)
      } else {
        await client.query('ROLLBACK');
        throw new Error('Counter can only remove items from active orders or served unpaid bills.');
      }
    } else if (role === 'manager') {
      if (order.status !== 'served' || order.payment_status !== 'unpaid') {
        await client.query('ROLLBACK');
        throw new Error('Only served unpaid orders can be edited by manager.');
      }
    } else if (role === 'waiter') {
      if (['served', 'completed', 'cancelled'].includes(order.status)) {
        await client.query('ROLLBACK');
        throw new Error('Cannot remove items from completed or served orders.');
      }
    } else {
      await client.query('ROLLBACK');
      throw new Error('Unauthorized');
    }


    const result =
      await client.query(
        `
        UPDATE order_items
         SET quantity = $1
         WHERE id = $2
           AND EXISTS (
             SELECT 1
             FROM orders o
             WHERE o.id = order_items.order_id
               AND o.restaurant_id = $3
           )
         RETURNING *
        `,
        [
          quantity,
          orderItemId,
          restaurantId
        ]
      );


    if (!result.rows.length) {

      await client.query('ROLLBACK');

      return null;

    }


    const orderId =
      order.id;


    // --------------------------------------------------
    // WAITER EDIT
    // --------------------------------------------------

    if (
      role !== 'manager' &&
      role !== 'counter'
    ) {

      // MENU orders need waiter acceptance.
      // WAITER / COUNTER / PHONE orders go directly to kitchen.
      const nextStatus =
        String(order.order_source || '').toUpperCase() === 'MENU'
          ? 'pending'
          : 'placed';

      await client.query(
        `
        UPDATE orders

        SET

          status = $1,

          confirmed_at = NULL,

          prep_minutes = NULL,

          ready_at = NULL

        WHERE id = $2

          AND restaurant_id = $3
        `,
        [
          nextStatus,
          orderId,
          restaurantId
        ]
      );

    }


    await recalculateOrderPricing(
      client,
      orderId,
      restaurantId
    );

    // --------------------------------------------------
// SYNC INVENTORY RESERVATION
//
// Waiter edits active order.
// Physical stock is NOT deducted.
// Old reservation is released and
// new reservation is created.
// --------------------------------------------------

if (order.status === 'served' && order.payment_status === 'unpaid') {

  await adjustServedOrderInventory(
    client,
    orderId,
    restaurantId,
    beforeItems
  );

} else {

  // Active orders must keep their reservation in sync,
  // including counter edits.
  await syncOrderInventoryReservation(
    client,
    orderId,
    restaurantId
  );

}


    await client.query('COMMIT');


    return {

      ...result.rows[0],

      order_id:
        orderId

    };

  }

  catch (err) {

    try {
      await client.query('ROLLBACK');
    }
    catch (_) {}

    throw err;

  }

  finally {

    client.release();

  }

};


// ======================================================
// REMOVE ORDER ITEM
// ======================================================

const removeOrderItem = async (
  orderItemId,
  restaurantId,
  role = 'waiter'
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    const orderCheck =
      await client.query(
        `
        SELECT

          o.id,

          o.status,

          o.payment_status,

          o.order_source

        FROM order_items oi

        INNER JOIN orders o
          ON o.id = oi.order_id

        WHERE oi.id = $1

          AND o.restaurant_id = $2

        FOR UPDATE
        `,
        [
          orderItemId,
          restaurantId
        ]
      );


    if (!orderCheck.rows.length) {

      await client.query('ROLLBACK');

      return false;

    }


    const order =
      orderCheck.rows[0];

    const beforeItemsResult = await client.query(
      'SELECT menu_item_id, variant_id, quantity FROM order_items WHERE order_id = $1',
      [order.id]
    );
    const beforeItems = beforeItemsResult.rows;


    // --------------------------------------------------
    // MANAGER / COUNTER
    // --------------------------------------------------

    if (role === 'counter') {

      // Counter Lite is a full operational POS.
      // It may remove items from active orders, and from
      // served unpaid bills just like quantity updates.
      const allowedActiveStatuses = [
        'pending',
        'placed',
        'accepted',
        'preparing'
      ];

      const isActiveOrder =
        allowedActiveStatuses.includes(order.status);

      const isServedUnpaid =
        order.status === 'served' &&
        order.payment_status === 'unpaid';

      if (!isActiveOrder && !isServedUnpaid) {

        await client.query('ROLLBACK');

        throw new Error(
          'Counter can only remove items from active orders or served unpaid bills.'
        );

      }

    } else if (role === 'manager') {

      if (
        order.status !== 'served' ||
        order.payment_status !== 'unpaid'
      ) {

        await client.query('ROLLBACK');

        throw new Error(
          'Only served unpaid orders can be edited by manager.'
        );

      }

    }


    // A served unpaid order has already consumed physical stock. Do not
    // delete its final item and then delete the order record: that would
    // bypass adjustServedOrderInventory and leave stock permanently reduced.
    if (
      order.status === 'served' &&
      order.payment_status === 'unpaid' &&
      beforeItems.length === 1
    ) {
      await client.query('ROLLBACK');
      throw new Error(
        'Cannot remove the last item from a served unpaid order. Adjust its quantity or use the approved void/refund workflow.'
      );
    }

    const result =
      await client.query(
        `
        DELETE FROM order_items
         WHERE id = $1
           AND EXISTS (
             SELECT 1
             FROM orders o
             WHERE o.id = order_items.order_id
               AND o.restaurant_id = $2
           )
         RETURNING id
        `,
        [
          orderItemId,
          restaurantId
        ]
      );


    if (!result.rows.length) {

      await client.query('ROLLBACK');

      return false;

    }

    const orderId =
      order.id;

    const items =
      await client.query(
        `
        SELECT

          COUNT(*)::int AS total

        FROM order_items

        WHERE order_id = $1
        `,
        [
          orderId
        ]
      );


    // --------------------------------------------------
    // EMPTY ORDER
    // --------------------------------------------------

    if (
      items.rows[0].total === 0
    ) {



      await client.query(


            `
    UPDATE inventory_reservations

    SET
      status = 'released',
      released_at = NOW()

    WHERE order_id = $1

      AND restaurant_id = $2

      AND status = 'reserved'
    `,
    [
      orderId,
      restaurantId
    ]
  );


  await client.query(
        `
        DELETE FROM orders

        WHERE id = $1

          AND restaurant_id = $2
        `,
        [
          orderId,
          restaurantId
        ]
      );

    }

    else {

      // ----------------------------------------------
      // WAITER EDIT
      // ----------------------------------------------

      if (
        role !== 'manager' &&
        role !== 'counter'
      ) {

        const nextStatus =
  String(order.order_source || '').toUpperCase() === 'MENU'
    ? 'pending'
    : 'placed';


await client.query(
  `
  UPDATE orders

  SET

    status = $1,

    confirmed_at = NULL,

    prep_minutes = NULL,

    ready_at = NULL

  WHERE id = $2

    AND restaurant_id = $3
  `,
  [
    nextStatus,
    orderId,
    restaurantId
  ]
);

      }


      await recalculateOrderPricing(
        client,
        orderId,
        restaurantId
      );

      // --------------------------------------------------
  // SYNC INVENTORY RESERVATION
  // --------------------------------------------------

  if (order.status === 'served' && order.payment_status === 'unpaid') {

    await adjustServedOrderInventory(
      client,
      orderId,
      restaurantId,
      beforeItems
    );

  } else {

    // Active orders must keep their reservation in sync,
    // including counter edits.
    await syncOrderInventoryReservation(
      client,
      orderId,
      restaurantId
    );

  }



    }


    await client.query('COMMIT');


    return true;

  }

  catch (err) {

    try {
      await client.query('ROLLBACK');
    }
    catch (_) {}

    throw err;

  }

  finally {

    client.release();

  }

};


// ======================================================
// RECALCULATE ORDER PRICING
// ======================================================

const recalculateOrderPricing = async (client, orderId, restaurantId) => {

  // ✅ Charges bhi fetch karo
  const orderResult = await client.query(
    `SELECT discount_type, discount_value, gst_percent, tax_percent,
            delivery_charge, dine_charge, card_charge, bank_charge
     FROM orders WHERE id = $1 AND restaurant_id = $2`,
    [orderId, restaurantId]
  );

  if (!orderResult.rows.length) return;

  const order = orderResult.rows[0];

  // Subtotal (items)
  const subtotalResult = await client.query(`
    SELECT COALESCE(SUM((oi.unit_price::numeric * oi.quantity::numeric)), 0) AS subtotal
    FROM order_items oi
    INNER JOIN menu_items m ON m.id = oi.menu_item_id
    LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id
    WHERE oi.order_id = $1 AND m.restaurant_id = $2 AND oi.order_deal_id IS NULL
  `, [orderId, restaurantId]);

  // Subtotal (deals)
  const dealsSubtotalResult = await client.query(`
    SELECT COALESCE(SUM(od.line_total), 0) AS subtotal
    FROM order_deals od
    INNER JOIN deals d ON d.id = od.deal_id
    WHERE od.order_id = $1 AND d.restaurant_id = $2
  `, [orderId, restaurantId]);

  const subtotal = Number(subtotalResult.rows[0].subtotal || 0) +
                   Number(dealsSubtotalResult.rows[0].subtotal || 0);

  const calculated = calculatePricing(
    subtotal,
    order.discount_type,
    order.discount_value,
    order.gst_percent,
    order.tax_percent
  );

  // ✅ Charges add karo
   const finalDeliveryCharge = Number(order.delivery_charge || 0);
  const finalDineCharge = Number(order.dine_charge || 0);
  const finalCardCharge = Number(order.card_charge || 0);
  const finalBankCharge = Number(order.bank_charge || 0);
  const finalTotal = calculated.totalAmount + finalDeliveryCharge + finalDineCharge + finalCardCharge + finalBankCharge;

  await client.query(
    `UPDATE orders SET
       subtotal = $1,
       discount_amount = $2,
       gst_amount = $3,
       tax_amount = $4,
       total_amount = $5
     WHERE id = $6 AND restaurant_id = $7`,
    [
      calculated.subtotal.toFixed(2),
      calculated.discountAmount.toFixed(2),
      calculated.gstAmount.toFixed(2),
      calculated.taxAmount.toFixed(2),
      finalTotal.toFixed(2),   // ✅
      orderId,
      restaurantId
    ]
  );
};




// ======================================================
// INVENTORY RESERVATION
// ======================================================

const reserveOrderInventory = async (
  client,
  orderId,
  restaurantId
) => {

  const ingredientsResult =
    await client.query(
      `
      SELECT
        mii.inventory_id,
        ii.name AS ingredient_name,
        ii.unit,
        ki.quantity AS stock_quantity, -- Changed
        mii.quantity AS recipe_quantity,
        oi.quantity AS order_quantity
      FROM order_items oi
      INNER JOIN menu_items mi
        ON mi.id = oi.menu_item_id
      INNER JOIN menu_item_ingredients mii
        ON mii.menu_item_id = mi.id
        AND (mii.variant_id IS NOT DISTINCT FROM oi.variant_id)
      INNER JOIN inventory_items ii
        ON ii.id = mii.inventory_id
      INNER JOIN kitchen_inventory ki -- Added JOIN
        ON ki.inventory_id = ii.id
        AND ki.restaurant_id = $2
      WHERE oi.order_id = $1
        AND mi.restaurant_id = $2
        AND ii.restaurant_id = $2
      `,
      [
        orderId,
        restaurantId
      ]
    );


  const requiredStock = {};


  for (const row of ingredientsResult.rows) {

    const inventoryId =
      Number(row.inventory_id);

    const recipeQuantity = Number(row.recipe_quantity);
    const orderQuantity = Number(row.order_quantity);
    const requiredQuantity = recipeQuantity * orderQuantity;

    if (
      !Number.isFinite(recipeQuantity) ||
      recipeQuantity <= 0 ||
      !Number.isFinite(orderQuantity) ||
      orderQuantity <= 0 ||
      !Number.isFinite(requiredQuantity) ||
      requiredQuantity <= 0
    ) {
      throw new Error(
        `Invalid recipe quantity for "${row.ingredient_name}".`
      );
    }


    if (!requiredStock[inventoryId]) {

      requiredStock[inventoryId] = {

        inventory_id:
          inventoryId,

        ingredient_name:
          row.ingredient_name,

        unit:
          row.unit,

        required_quantity:
          0

      };

    }


    requiredStock[inventoryId]
      .required_quantity +=
      requiredQuantity;

  }


  // --------------------------------------------------
  // CHECK AVAILABLE STOCK
  //
  // available =
  // physical stock - already reserved
  //
  // Inventory is NOT deducted here.
  // --------------------------------------------------

  for (
    const inventoryId
    of Object.keys(requiredStock)
  ) {

    const item =
      requiredStock[inventoryId];


        const inventoryResult =
      await client.query(
        `
        SELECT
          ki.id,
          ii.name,
          ii.unit,
          ki.quantity AS stock_quantity
        FROM kitchen_inventory ki
        INNER JOIN inventory_items ii ON ii.id = ki.inventory_id
        WHERE ki.inventory_id = $1
          AND ki.restaurant_id = $2
        FOR UPDATE
        `,
        [
          item.inventory_id,
          restaurantId
        ]
      );


    if (!inventoryResult.rows.length) {

      throw new Error(
        `Inventory item "${item.ingredient_name}" not found.`
      );

    }


    const stock =
      Number(
        inventoryResult.rows[0].stock_quantity || 0
      );


    if (!Number.isFinite(stock)) {

      throw new Error(
        `Invalid stock quantity for "${item.ingredient_name}".`
      );

    }


    const reservedResult =
      await client.query(
        `
        SELECT
          COALESCE(
            SUM(quantity),
            0
          ) AS reserved_quantity
        FROM inventory_reservations
        WHERE inventory_id = $1
          AND restaurant_id = $2
          AND status = 'reserved'
        `,
        [
          item.inventory_id,
          restaurantId
        ]
      );


    const alreadyReserved =
      Number(
        reservedResult.rows[0].reserved_quantity || 0
      );


    const available =
      stock - alreadyReserved;


    if (
      available <
      item.required_quantity
    ) {

      throw new Error(
        `Insufficient available stock for "${item.ingredient_name}". ` +
        `Available: ${available} ${item.unit}, ` +
        `Required: ${item.required_quantity} ${item.unit}.`
      );

    }

  }


  // --------------------------------------------------
  // CREATE RESERVATIONS
  // --------------------------------------------------

  for (
    const inventoryId
    of Object.keys(requiredStock)
  ) {

    const item =
      requiredStock[inventoryId];


    if (
      item.required_quantity <= 0
    ) {
      continue;
    }


    await client.query(
      `
      INSERT INTO inventory_reservations
      (
        order_id,
        inventory_id,
        quantity,
        status,
        restaurant_id
      )
      VALUES
      (
        $1,
        $2,
        $3,
        'reserved',
        $4
      )
      `,
      [
        orderId,
        item.inventory_id,
        item.required_quantity,
        restaurantId
      ]
    );

  }


  return {
    reserved: true
  };

};


// ======================================================
// RELEASE INVENTORY RESERVATIONS
//
// Used when an order is cancelled/deleted before serving.
// Physical stock is NOT changed because it was never deducted.
// ======================================================

const releaseOrderInventory = async (
  client,
  orderId,
  restaurantId
) => {

  const result =
    await client.query(
      `
      UPDATE inventory_reservations ir

      SET
        status = 'released',
        released_at = NOW()

      FROM orders o

      WHERE ir.order_id = o.id

        AND ir.order_id = $1

        AND o.restaurant_id = $2

        AND ir.status = 'reserved'

      RETURNING ir.*
      `,
      [
        orderId,
        restaurantId
      ]
    );


  return result.rows;

};


// ======================================================
// CANCEL ORDER + RELEASE RESERVATION
// ======================================================

const cancelOrder = async (
  orderId,
  restaurantId
) => {

  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');


    const orderResult =
      await client.query(
        `
        SELECT
          id,
          status,
          payment_status

        FROM orders

        WHERE id = $1

          AND restaurant_id = $2

        FOR UPDATE
        `,
        [
          orderId,
          restaurantId
        ]
      );


    if (!orderResult.rows.length) {

      await client.query('ROLLBACK');

      return null;

    }


    const order =
      orderResult.rows[0];


    // --------------------------------------------------
    // CANNOT CANCEL AFTER SERVING
    // --------------------------------------------------

    if (
      ![
        'pending',
        'placed',
        'accepted',
        'preparing',
        'confirmed',
        'ready',
        'ready_to_dispatch',
        'ready_to_deliver'
      ].includes(order.status) ||
      order.payment_status === 'paid'
    ) {

      await client.query('ROLLBACK');

      throw new Error(
        'This order cannot be cancelled.'
      );

    }


    // --------------------------------------------------
    // RELEASE ACTIVE RESERVATIONS
    // --------------------------------------------------

    await releaseOrderInventory(
      client,
      orderId,
      restaurantId
    );


    // --------------------------------------------------
    // CANCEL ORDER
    // --------------------------------------------------

    const result =
      await client.query(
        `
        UPDATE orders

        SET
          status = 'cancelled'

        WHERE id = $1

          AND restaurant_id = $2

        RETURNING *
        `,
        [
          orderId,
          restaurantId
        ]
      );


    await client.query('COMMIT');


    return result.rows[0] || null;

  }

  catch (err) {

    try {
      await client.query('ROLLBACK');
    }
    catch (_) {}

    throw err;

  }

  finally {

    client.release();

  }

};


// ======================================================
// SYNC ORDER INVENTORY RESERVATION
//
// Used when an active order's items change.
//
// Old active reservation is released.
// Current order requirements are recalculated.
// New reservation is created.
//
// Physical inventory is NOT deducted here.
// ======================================================

const syncOrderInventoryReservation = async (
  client,
  orderId,
  restaurantId
) => {

  // --------------------------------------------------
  // RELEASE OLD RESERVATION
  // --------------------------------------------------

  await client.query(
    `
    UPDATE inventory_reservations

    SET
      status = 'released',
      released_at = NOW()

    WHERE order_id = $1

      AND restaurant_id = $2

      AND status = 'reserved'
    `,
    [
      orderId,
      restaurantId
    ]
  );


  // --------------------------------------------------
  // GET CURRENT ORDER INGREDIENT REQUIREMENTS
  // --------------------------------------------------

    const ingredientsResult =
    await client.query(
      `
      SELECT

        mii.inventory_id,

        ii.name AS ingredient_name,

        ii.unit,

        ki.quantity AS stock_quantity, -- Changed to kitchen

        mii.quantity AS recipe_quantity,

        oi.quantity AS order_quantity

            FROM order_items oi
      INNER JOIN menu_items mi
        ON mi.id = oi.menu_item_id
      INNER JOIN menu_item_ingredients mii
        ON mii.menu_item_id = mi.id
        AND (mii.variant_id IS NOT DISTINCT FROM oi.variant_id)
      INNER JOIN inventory_items ii
        ON ii.id = mii.inventory_id
      INNER JOIN kitchen_inventory ki -- Added JOIN
        ON ki.inventory_id = ii.id
        AND ki.restaurant_id = $2
      WHERE oi.order_id = $1
        AND mi.restaurant_id = $2
        AND ii.restaurant_id = $2
      `,
      [
        orderId,
        restaurantId
      ]
    );


  // --------------------------------------------------
  // NO RECIPES
  // --------------------------------------------------

  if (
    !ingredientsResult.rows.length
  ) {

    return {
      reserved: true
    };

  }


  // --------------------------------------------------
  // CALCULATE REQUIRED STOCK
  // --------------------------------------------------

  const requiredStock = {};


  for (
    const row
    of ingredientsResult.rows
  ) {

    const inventoryId =
      Number(row.inventory_id);


    const recipeQuantity =
      Number(row.recipe_quantity || 0);


    const orderQuantity =
      Number(row.order_quantity || 0);


    const requiredQuantity =
      recipeQuantity *
      orderQuantity;

    if (
      !Number.isFinite(recipeQuantity) ||
      recipeQuantity <= 0 ||
      !Number.isFinite(orderQuantity) ||
      orderQuantity <= 0 ||
      !Number.isFinite(requiredQuantity) ||
      requiredQuantity <= 0
    ) {

      throw new Error(
        `Invalid recipe quantity for "${row.ingredient_name}".`
      );

    }


    if (
      !requiredStock[inventoryId]
    ) {

      requiredStock[inventoryId] = {

        inventory_id:
          inventoryId,

        ingredient_name:
          row.ingredient_name,

        unit:
          row.unit,

        required_quantity:
          0

      };

    }


    requiredStock[inventoryId]
      .required_quantity +=
      requiredQuantity;

  }


  // --------------------------------------------------
  // CHECK AVAILABLE STOCK
  //
  // Old reservation has already been released,
  // therefore current active reservations represent
  // other orders only.
  // --------------------------------------------------

  for (
    const inventoryId
    of Object.keys(requiredStock)
  ) {

    const item =
      requiredStock[inventoryId];


    if (
      item.required_quantity <= 0
    ) {

      continue;

    }


                const inventoryResult =
      await client.query(
        `
        SELECT
          ki.id,
          ii.name,
          ii.unit,
          ki.quantity AS stock_quantity
        FROM kitchen_inventory ki
        INNER JOIN inventory_items ii ON ii.id = ki.inventory_id
        WHERE ki.inventory_id = $1
          AND ki.restaurant_id = $2
        FOR UPDATE
        `,
        [
          item.inventory_id,
          restaurantId
        ]
      );


    if (
      !inventoryResult.rows.length
    ) {

      throw new Error(
        `Inventory item "${item.ingredient_name}" not found.`
      );

    }


    const stock =
      Number(
        inventoryResult.rows[0].stock_quantity || 0
      );


    if (
      !Number.isFinite(stock)
    ) {

      throw new Error(
        `Invalid stock quantity for "${item.ingredient_name}".`
      );

    }


    const reservedResult =
      await client.query(
        `
        SELECT

          COALESCE(
            SUM(quantity),
            0
          ) AS reserved_quantity

        FROM inventory_reservations

        WHERE inventory_id = $1

          AND restaurant_id = $2

          AND status = 'reserved'
        `,
        [
          item.inventory_id,
          restaurantId
        ]
      );


    const alreadyReserved =
      Number(
        reservedResult.rows[0]
          .reserved_quantity || 0
      );


    const available =
      stock -
      alreadyReserved;


    if (
      available <
      item.required_quantity
    ) {

      throw new Error(
        `Insufficient available stock for "${item.ingredient_name}". ` +
        `Available: ${available} ${item.unit}, ` +
        `Required: ${item.required_quantity} ${item.unit}.`
      );

    }

  }


  // --------------------------------------------------
  // CREATE NEW RESERVATIONS
  // --------------------------------------------------

  for (
    const inventoryId
    of Object.keys(requiredStock)
  ) {

    const item =
      requiredStock[inventoryId];


    if (
      item.required_quantity <= 0
    ) {

      continue;

    }


    await client.query(
      `
      INSERT INTO inventory_reservations
      (
        order_id,
        inventory_id,
        quantity,
        status,
        restaurant_id
      )

      VALUES
      (
        $1,
        $2,
        $3,
        'reserved',
        $4
      )
      `,
      [
        orderId,
        item.inventory_id,
        item.required_quantity,
        restaurantId
      ]
    );

  }


  return {
    reserved: true
  };

};

// ======================================================
// FIND CUSTOMER BY PHONE (for delivery auto-fill)
// Looks at most recent order with this phone number
// and returns their last known name + address.
// ======================================================

const findCustomerByPhone = async (
  phone,
  restaurantId
) => {

  const result = await pool.query(
    `
    SELECT

      customer_name,

      delivery_address,

      COUNT(*) OVER() AS order_count

    FROM orders

    WHERE restaurant_id = $1

      AND delivery_phone = $2

    ORDER BY created_at DESC

    LIMIT 1
    `,
    [restaurantId, phone]
  );

  return result.rows[0] || null;

};

// ======================================================
// GET MY DELIVERY ORDERS
//
// Current rider ke assigned delivery orders.
//
// Delivery rider only.
// ======================================================

const getMyDeliveryOrders = async (
  restaurantId,
  riderId
) => {

  const result =
    await pool.query(
      `
      SELECT

        o.*,

        COALESCE(
          (
            SELECT json_agg(
              row_to_json(item_rows)
            )
            FROM (
              SELECT

                oi.id AS order_item_id,
                oi.menu_item_id,
                oi.variant_id,
                miv.label AS variant_label,
                m.name,

                oi.unit_price AS price,

                oi.quantity,
                oi.new_quantity,

                oi.line_total AS subtotal

              FROM order_items oi

              INNER JOIN menu_items m
                ON m.id = oi.menu_item_id

              LEFT JOIN menu_item_variants miv
                ON miv.id = oi.variant_id

              WHERE oi.order_id = o.id
                AND oi.order_deal_id IS NULL

            ) item_rows
          ),
          '[]'
        ) AS items,


        COALESCE(
          (
            SELECT json_agg(deal_rows)
            FROM (
              SELECT

                od.id AS order_deal_id,
                od.deal_id,
                d.name AS deal_name,
                d.type AS deal_type,
                od.quantity,
                od.unit_price AS price,
                od.line_total AS subtotal,

                COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'menu_item_id',
                          oi2.menu_item_id,

                        'variant_id',
                          oi2.variant_id,

                        'variant_label',
                          miv2.label,

                        'name',
                          m2.name,

                        'quantity',
                          oi2.quantity

                        
                      )
                    )

                    FROM order_items oi2

                    INNER JOIN menu_items m2
                      ON m2.id = oi2.menu_item_id

                    LEFT JOIN menu_item_variants miv2
                      ON miv2.id = oi2.variant_id

                    WHERE oi2.order_deal_id = od.id
                  ),
                  '[]'
                ) AS items

              FROM order_deals od

              INNER JOIN deals d
                ON d.id = od.deal_id

              WHERE od.order_id = o.id

            ) deal_rows
          ),
          '[]'
        ) AS deals,


        COALESCE(
          o.total_amount,
          0
        ) AS total


      FROM orders o

      WHERE o.restaurant_id = $1

        AND o.delivery_rider_id = $2

        AND o.order_type = 'delivery'

        AND o.status IN (
          'ready_to_deliver',
          'out_for_delivery',
          'delivered',
          'completed'
        )

      ORDER BY
        o.created_at DESC
      `,
      [
        restaurantId,
        riderId
      ]
    );


  return result.rows;

};

const getDeliveryRiders = async (
  restaurantId
) => {

  const result = await pool.query(
    `
    SELECT
      u.id,
      u.username,
      u.full_name,
      u.role,
      u.is_active,

      CASE
        WHEN EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.user_id = u.id
            AND s.restaurant_id = u.restaurant_id
            AND s.status = 'active'
        )
        THEN true
        ELSE false
      END AS shift_active,

      COUNT(o.id)::integer AS active_order_count

    FROM users u

    LEFT JOIN orders o
      ON o.delivery_rider_id = u.id
      AND o.restaurant_id = u.restaurant_id
      AND o.order_type = 'delivery'
      AND o.status IN (
        'ready_to_deliver',
        'out_for_delivery'
      )

    WHERE u.restaurant_id = $1
      AND u.role = 'delivery'

    GROUP BY
      u.id,
      u.username,
      u.full_name,
      u.role,
      u.is_active

    ORDER BY
      u.is_active DESC,
      active_order_count ASC,
      u.full_name,
      u.id
    `,
    [
      restaurantId
    ]
  );

  return result.rows;
};

const assignDeliveryRider = async (orderId, restaurantId, riderId) => {
  // Plan check
  const planRes = await pool.query(
    `SELECT plan FROM restaurants WHERE id = $1`,
    [restaurantId]
  );
  const isCafeLite = planRes.rows[0]?.plan === 'Cafe Lite';

  // Cafe Lite: placed/ready_to_deliver; Full: only ready_to_deliver
  const allowed = isCafeLite
    ? ['placed', 'ready_to_deliver', 'preparing', 'ready']
    : ['ready_to_deliver'];

  const result = await pool.query(
    `
    UPDATE orders o
    SET
      delivery_rider_id = $3,
      status = CASE
        WHEN o.status = 'ready_to_deliver' THEN o.status
        ELSE 'ready_to_deliver'
      END,
      ready_at = COALESCE(o.ready_at, NOW())
    FROM users u
    WHERE o.id = $1
      AND o.restaurant_id = $2
      AND o.order_type = 'delivery'
      AND o.status = ANY($4::text[])
      AND u.id = $3
      AND u.restaurant_id = $2
      AND u.role = 'delivery'
      AND u.is_active = true
      AND EXISTS (
        SELECT 1
        FROM shifts s
        WHERE s.user_id = u.id
          AND s.restaurant_id = u.restaurant_id
          AND s.status = 'active'
      )
    RETURNING o.*
    `,
    [orderId, restaurantId, riderId, allowed]
  );

  // push notification — pehle wala try/catch same rehne do
  if (result.rows[0]) {
    try {
      const { sendPushToUser } = require('../routes/pushRoutes');
      const order = result.rows[0];
      await sendPushToUser(riderId, {
        title: `New Order #${order.local_number || order.id}`,
        body: `${order.customer_name || 'Customer'} — ${order.delivery_address || ''}`,
        tag: `order-${order.id}`,
        data: { url: `/rider?restaurant=${restaurantId}`, orderId: order.id }
      });
    } catch (err) {
      console.error('Push send failed:', err);
    }
  }

  return result.rows[0] || null;
};


const unassignDeliveryRider = async (
  orderId,
  restaurantId
) => {

  const result = await pool.query(
    `
    UPDATE orders
    SET delivery_rider_id = NULL
    WHERE id = $1
      AND restaurant_id = $2
      AND order_type = 'delivery'
      AND status IN (
        'placed',
        'preparing',
        'ready',
        'ready_to_deliver'
      )
    RETURNING *
    `,
    [
      orderId,
      restaurantId
    ]
  );

  return result.rows[0] || null;
};


// ======================================================
// AUTO ASSIGN LEAST-LOADED DELIVERY RIDER
//
// Rules:
// - delivery order only
// - ready_to_deliver only
// - active delivery riders only
// - active workload = ready_to_deliver + out_for_delivery
// - lowest workload rider gets the order
// - transaction locks riders to prevent double assignment
// ======================================================

const autoAssignDeliveryRider = async (
  orderId,
  restaurantId
) => {

  const client = await pool.connect();

  try {

    await client.query('BEGIN');

    // --------------------------------------------------
    // Validate + lock active delivery riders
    // --------------------------------------------------

    const ridersResult = await client.query(
      `
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.role,
        u.is_active
      FROM users u
      WHERE u.restaurant_id = $1
        AND u.role = 'delivery'
        AND u.is_active = true
        AND EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.user_id = u.id
            AND s.restaurant_id = u.restaurant_id
            AND s.status = 'active'
        )
      ORDER BY u.id
      FOR UPDATE OF u
      `,
      [restaurantId]
    );

    if (ridersResult.rows.length === 0) {

      await client.query('ROLLBACK');

      return null;
    }


    // --------------------------------------------------
    // Verify target order
    // ✅ Cafe Lite: allow placed/preparing/ready/ready_to_deliver
    // --------------------------------------------------

    // Restaurant plan check
    const planRes = await client.query(
      `SELECT plan FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    const plan = planRes.rows[0]?.plan || 'Basic';
    const isCafeLite = plan === 'Cafe Lite';

    const allowedStatuses = isCafeLite
      ? ['placed', 'preparing', 'ready', 'ready_to_deliver']
      : ['ready_to_deliver'];

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
        AND restaurant_id = $2
        AND order_type = 'delivery'
        AND status = ANY($3::text[])
      FOR UPDATE
      `,
      [
        orderId,
        restaurantId,
        allowedStatuses
      ]
    );

    if (orderResult.rows.length === 0) {

      await client.query('ROLLBACK');

      return null;
    }


    // --------------------------------------------------
    // Count each rider's active workload
    // --------------------------------------------------

    const workloadResult = await client.query(
      `
      SELECT
        u.id AS rider_id,
        COUNT(o.id)::integer AS active_order_count
      FROM users u

      LEFT JOIN orders o
        ON o.delivery_rider_id = u.id
        AND o.restaurant_id = $1
        AND o.status IN (
          'ready_to_deliver',
          'out_for_delivery'
        )

      WHERE u.restaurant_id = $1
        AND u.role = 'delivery'
        AND u.is_active = true
        AND EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.user_id = u.id
            AND s.restaurant_id = u.restaurant_id
            AND s.status = 'active'
        )

      GROUP BY u.id

      ORDER BY
        COUNT(o.id) ASC,
        u.id ASC
      `,
      [restaurantId]
    );


    const selectedRider =
      workloadResult.rows[0];


    if (!selectedRider) {

      await client.query('ROLLBACK');

      return null;
    }


    // --------------------------------------------------
    // Assign rider
    // --------------------------------------------------

    const updateResult = await client.query(
      `
      UPDATE orders
      SET
        delivery_rider_id = $3,
        status = CASE
          WHEN status = 'ready_to_deliver' THEN status
          ELSE 'ready_to_deliver'
        END,
        ready_at = COALESCE(ready_at, NOW())
      WHERE id = $1
        AND restaurant_id = $2
        AND order_type = 'delivery'
        AND status = ANY($4::text[])
      RETURNING *
      `,
      [
        orderId,
        restaurantId,
        selectedRider.rider_id,
        allowedStatuses
      ]
    );


    if (updateResult.rows.length === 0) {

      await client.query('ROLLBACK');

      return null;
    }


    await client.query('COMMIT');

    // ✅ Send push notification to assigned rider
    try {
        const { sendPushToUser } = require('../routes/pushRoutes');
        
        await sendPushToUser(selectedRider.rider_id, {
            title: `🚴 Naya Order #${updateResult.rows[0].id}`,
            body: `Auto-assigned delivery order`,
            data: {
                url: `/rider?restaurant=${restaurantId}`,
                orderId: updateResult.rows[0].id
            }
        });
    } catch(err) {
        console.error('Push send failed:', err);
    }

    return {
      order: updateResult.rows[0],
      rider_id: Number(selectedRider.rider_id),
      active_order_count:
        Number(selectedRider.active_order_count) + 1
    };

  }
  catch (err) {

    await client.query('ROLLBACK');

    throw err;

  }
  finally {

    client.release();

  }

};


// ======================================================
// DELIVERY RIDER SUMMARY
//
// Filters:
// - date: YYYY-MM-DD
// - from: YYYY-MM-DD
// - to: YYYY-MM-DD
//
// Only delivery orders assigned to a rider are counted.
// ======================================================

const getRiderSummary = async (
  restaurantId,
  filters = {}
) => {

  const params = [restaurantId];

  let dateCondition = '';

  // ----------------------------------------------------
  // DATE FILTER
  // ----------------------------------------------------

  if (filters.date) {

    params.push(filters.date);

    dateCondition = `
      AND o.created_at::date = $${params.length}::date
    `;

  }

  // ----------------------------------------------------
  // DATE RANGE
  // ----------------------------------------------------

  else {

    if (filters.from) {

      params.push(filters.from);

      dateCondition += `
        AND o.created_at >= $${params.length}::date
      `;

    }

    if (filters.to) {

      params.push(filters.to);

      dateCondition += `
        AND o.created_at < ($${params.length}::date + INTERVAL '1 day')
      `;

    }

  }

  const result = await pool.query(
    `
    SELECT

      u.id,
u.username,
u.full_name,
u.is_active,

CASE
  WHEN EXISTS (
    SELECT 1
    FROM shifts s
    WHERE s.user_id = u.id
      AND s.restaurant_id = u.restaurant_id
      AND s.status = 'active'
  )
  THEN true
  ELSE false
END AS shift_active,

      COUNT(o.id)::integer AS order_count,

      COUNT(o.id) FILTER (
        WHERE o.status = 'delivered'
      )::integer AS delivered_count,

      COUNT(o.id) FILTER (
        WHERE o.status = 'completed'
      )::integer AS completed_count,

      COUNT(o.id) FILTER (
        WHERE o.status IN (
          'ready_to_deliver',
          'out_for_delivery'
        )
      )::integer AS active_count,

      COUNT(o.id) FILTER (
        WHERE o.status = 'cancelled'
      )::integer AS cancelled_count,

      COALESCE(
        SUM(o.total_amount),
        0
      ) AS total_sales

    FROM users u

    LEFT JOIN orders o
      ON o.delivery_rider_id = u.id
      AND o.restaurant_id = $1
      AND o.order_type = 'delivery'
      ${dateCondition}

    WHERE
      u.restaurant_id = $1
      AND u.role = 'delivery'

    GROUP BY
      u.id,
      u.username,
      u.full_name,
      u.is_active

    ORDER BY
      COUNT(o.id) DESC,
      u.full_name ASC,
      u.id ASC
    `,
    params
  );

  const riders = result.rows.map(
    (rider, index) => ({

      rank: index + 1,

      id: Number(rider.id),

      username: rider.username,

      full_name: rider.full_name,

      is_active:
      Boolean(rider.is_active),

      shift_active:
      Boolean(rider.shift_active),

      order_count:
        Number(rider.order_count || 0),

      delivered_count:
        Number(rider.delivered_count || 0),

      completed_count:
        Number(rider.completed_count || 0),

      active_count:
        Number(rider.active_count || 0),

      cancelled_count:
        Number(rider.cancelled_count || 0),

      total_sales:
        Number(rider.total_sales || 0)

    })
  );

  const totals = riders.reduce(
    (sum, rider) => {

      sum.order_count +=
        rider.order_count;

      sum.delivered_count +=
        rider.delivered_count;

      sum.completed_count +=
        rider.completed_count;

      sum.active_count +=
        rider.active_count;

      sum.cancelled_count +=
        rider.cancelled_count;

      sum.total_sales +=
        rider.total_sales;

      return sum;

    },
    {
      order_count: 0,
      delivered_count: 0,
      completed_count: 0,
      active_count: 0,
      cancelled_count: 0,
      total_sales: 0
    }
  );

  // ----------------------------------------------------
  // TOP RIDER
  // Only rider having at least 1 order
  // ----------------------------------------------------

  const topRider =
    riders.find(
      rider => rider.order_count > 0
    ) || null;

  return {

    riders,

    totals,

    top_rider: topRider

  };

};

// ======================================================
// GET ORDER BY ID (for FBR submission)
// ======================================================

const getOrderById = async (orderId, restaurantId = null) => {
  let query = `SELECT * FROM orders WHERE id = $1`;
  const params = [orderId];

  if (restaurantId) {
    query += ` AND restaurant_id = $2`;
    params.push(restaurantId);
  }

  const result = await pool.query(query, params);
  return result.rows[0] || null;
};

// ======================================================
// GET ORDER ITEMS BY ORDER ID (for FBR submission)
// ======================================================

const getOrderItemsByOrderId = async (orderId, restaurantId = null) => {
  const result = await pool.query(
    `SELECT
       oi.id,
       oi.menu_item_id,
       oi.variant_id,
       oi.quantity,
       m.name,
       oi.unit_price AS price,
       oi.line_total AS line_total,
       miv.label AS variant_label
     FROM order_items oi
     INNER JOIN orders o ON o.id = oi.order_id
     INNER JOIN menu_items m ON m.id = oi.menu_item_id
     LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id
     WHERE oi.order_id = $1
       AND ($2::integer IS NULL OR o.restaurant_id = $2)
     ORDER BY oi.id`,
    [orderId, restaurantId]
  );
  return result.rows;
};

module.exports = {

  createOrder,

  syncOrderInventoryReservation,

  reserveOrderInventory,

  releaseOrderInventory,

  cancelOrder,

  getAllOrders,

  confirmOrder,

  markReady,

  markOutForDelivery,

  markDelivered,

  markCompleted,

  markServed,

  getOrderById,          
       
  getOrderItemsByOrderId,

  markWalkInHandedOver,

  markPaid,

  getActiveOrderForTable,

  addItemsToOrder,

  updateOrderItemQuantity,

  removeOrderItem,

  acceptOrder,

  updateOrderPricing,

  findCustomerByPhone,

  getMyDeliveryOrders,

  getDeliveryRiders,

  assignDeliveryRider,

  unassignDeliveryRider,

  autoAssignDeliveryRider,

  getRiderSummary,

  adjustServedOrderInventory

};