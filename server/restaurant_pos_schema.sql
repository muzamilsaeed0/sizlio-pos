--
-- PostgreSQL database schema
-- Restaurant POS
-- Phase 1 - Step 1
-- Order Source / Order Type / Payment Timing Foundation
--

\restrict 3yuQVrE53dktVYKIwKnJXqefWComFotgMmfR55Bnlus9EoYuS7oT66wSFwxGfej

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';
SET default_table_access_method = heap;


--
-- Name: inventory_items; Type: TABLE; Schema: public
--

CREATE TABLE public.inventory_items (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    category character varying(50) DEFAULT 'Other'::character varying,
    unit character varying(20) NOT NULL,
    stock_quantity numeric(10,2) DEFAULT 0,
    minimum_stock numeric(10,2) DEFAULT 0,
    purchase_price numeric(10,2) DEFAULT 0,
    supplier character varying(100),
    restaurant_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true
);


--
-- Name: inventory_items_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.inventory_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.inventory_items_id_seq
    OWNED BY public.inventory_items.id;


--
-- Name: inventory_transactions; Type: TABLE; Schema: public
--

CREATE TABLE public.inventory_transactions (
    id integer NOT NULL,
    inventory_id integer NOT NULL,
    type character varying(20) NOT NULL,
    quantity numeric(10,2) NOT NULL,
    note text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: inventory_transactions_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.inventory_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.inventory_transactions_id_seq
    OWNED BY public.inventory_transactions.id;


--
-- Name: menu_item_ingredients; Type: TABLE; Schema: public
--

CREATE TABLE public.menu_item_ingredients (
    id integer NOT NULL,
    menu_item_id integer NOT NULL,
    inventory_id integer NOT NULL,
    quantity numeric(10,2) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: menu_item_ingredients_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.menu_item_ingredients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.menu_item_ingredients_id_seq
    OWNED BY public.menu_item_ingredients.id;


--
-- Name: menu_items; Type: TABLE; Schema: public
--

CREATE TABLE public.menu_items (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    price numeric(10,2) NOT NULL,
    active boolean DEFAULT true,
    category character varying(50) DEFAULT 'Other'::character varying,
    restaurant_id integer NOT NULL,
    image text
);


--
-- Name: menu_items_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.menu_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.menu_items_id_seq
    OWNED BY public.menu_items.id;


--
-- Name: order_items; Type: TABLE; Schema: public
--

CREATE TABLE public.order_items (
    id integer NOT NULL,
    order_id integer,
    menu_item_id integer,
    quantity integer DEFAULT 1 NOT NULL
);


--
-- Name: order_items_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.order_items_id_seq
    OWNED BY public.order_items.id;


--
-- Name: orders; Type: TABLE; Schema: public
--

CREATE TABLE public.orders (
    id integer NOT NULL,

    table_no integer NOT NULL,

    status character varying(20)
        DEFAULT 'pending'::character varying,

    prep_minutes integer,

    created_at timestamp without time zone
        DEFAULT now(),

    confirmed_at timestamp without time zone,

    ready_at timestamp without time zone,

    served_at timestamp without time zone,

    payment_status character varying(20)
        DEFAULT 'unpaid'::character varying,

    paid_at timestamp without time zone,

    restaurant_id integer,

    customer_name character varying(100),

    /*
     * Phase 1 - Step 1
     *
     * Where did this order come from?
     *
     * MENU    = Customer QR/Public Menu
     * WAITER  = Waiter Screen
     * COUNTER = Counter Screen
     * PHONE   = Phone/Delivery Order
     */
    order_source character varying(20)
        DEFAULT 'MENU'::character varying
        NOT NULL,

    /*
     * Phase 1 - Step 1
     *
     * Dine-in or Delivery
     */
    order_type character varying(20)
        DEFAULT 'dine_in'::character varying
        NOT NULL,

    /*
     * Phase 1 - Step 1
     *
     * PAY_LATER    = Payment after serving
     * PAID_AT_ORDER = Customer already paid
     * COD          = Cash on delivery
     */
    payment_timing character varying(20)
        DEFAULT 'PAY_LATER'::character varying
        NOT NULL,

    /*
     * Delivery information
     */
    delivery_phone character varying(30),

    delivery_address text,

    payment_method character varying(30)
        DEFAULT 'Cash'::character varying,

    paid_amount numeric(12,2)
        DEFAULT 0,

    subtotal numeric(12,2)
        DEFAULT 0,

    discount_type character varying(20)
        DEFAULT 'none'::character varying,

    discount_value numeric(12,2)
        DEFAULT 0,

    discount_amount numeric(12,2)
        DEFAULT 0,

    gst_percent numeric(5,2)
        DEFAULT 0,

    gst_amount numeric(12,2)
        DEFAULT 0,

    tax_percent numeric(5,2)
        DEFAULT 0,

    tax_amount numeric(12,2)
        DEFAULT 0,

    total_amount numeric(12,2)
        DEFAULT 0,

    /*
     * Existing order status values.
     *
     * Phase 1 - Step 2 mein status system
     * ko expand kiya jayega.
     */
    CONSTRAINT orders_status_check
        CHECK (
            (status)::text = ANY (
                (
                    ARRAY[
                        'pending'::character varying,
                        'accepted'::character varying,
                        'confirmed'::character varying,
                        'ready'::character varying,
                        'served'::character varying,
                        'ready_to_deliver'::character varying,
                        'out_for_delivery'::character varying,
                        'delivered'::character varying,
                        'completed'::character varying
                    ]
                )::text[]
            )
        ),

    /*
     * Phase 1 - Step 1
     *
     * Order source validation
     */
    CONSTRAINT orders_source_check
        CHECK (
            (order_source)::text = ANY (
                (
                    ARRAY[
                        'MENU'::character varying,
                        'WAITER'::character varying,
                        'COUNTER'::character varying,
                        'PHONE'::character varying
                    ]
                )::text[]
            )
        ),

    /*
     * Phase 1 - Step 1
     *
     * Order type validation
     */
    CONSTRAINT orders_type_check
        CHECK (
            (order_type)::text = ANY (
                (
                    ARRAY[
                        'dine_in'::character varying,
                        'delivery'::character varying
                    ]
                )::text[]
            )
        ),

    /*
     * Phase 1 - Step 1
     *
     * Payment timing validation
     */
    CONSTRAINT orders_payment_timing_check
        CHECK (
            (payment_timing)::text = ANY (
                (
                    ARRAY[
                        'PAY_LATER'::character varying,
                        'PAID_AT_ORDER'::character varying,
                        'COD'::character varying
                    ]
                )::text[]
            )
        )
);


--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.orders_id_seq
    OWNED BY public.orders.id;


--
-- Name: restaurants; Type: TABLE; Schema: public
--

CREATE TABLE public.restaurants (
    id integer NOT NULL,
    name character varying(150) NOT NULL,
    owner_name character varying(100),
    phone character varying(20),
    email character varying(100),
    city character varying(100),
    address text,
    plan character varying(50) DEFAULT 'Basic'::character varying,
    status character varying(20) DEFAULT 'Active'::character varying,
    expiry_date date,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    manager_username character varying(50),
    manager_password character varying(50),
    waiter_username character varying(50),
    waiter_password character varying(50),
    kitchen_username character varying(50),
    kitchen_password character varying(50),
    logo_url character varying(255)
);


--
-- Name: restaurants_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.restaurants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.restaurants_id_seq
    OWNED BY public.restaurants.id;


--
-- Name: users; Type: TABLE; Schema: public
--

CREATE TABLE public.users (
    id integer NOT NULL,
    full_name character varying(100) NOT NULL,
    username character varying(50) NOT NULL,
    password character varying(255) NOT NULL,
    role character varying(20) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    restaurant_id integer,

    CONSTRAINT users_role_check
        CHECK (
            (role)::text = ANY (
                ARRAY[
                    'manager'::text,
                    'waiter'::text,
                    'kitchen'::text,
                    'super_admin'::text
                ]
            )
        )
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq
    OWNED BY public.users.id;


--
-- Defaults
--

ALTER TABLE ONLY public.inventory_items
    ALTER COLUMN id
    SET DEFAULT nextval('public.inventory_items_id_seq'::regclass);

ALTER TABLE ONLY public.inventory_transactions
    ALTER COLUMN id
    SET DEFAULT nextval('public.inventory_transactions_id_seq'::regclass);

ALTER TABLE ONLY public.menu_item_ingredients
    ALTER COLUMN id
    SET DEFAULT nextval('public.menu_item_ingredients_id_seq'::regclass);

ALTER TABLE ONLY public.menu_items
    ALTER COLUMN id
    SET DEFAULT nextval('public.menu_items_id_seq'::regclass);

ALTER TABLE ONLY public.order_items
    ALTER COLUMN id
    SET DEFAULT nextval('public.order_items_id_seq'::regclass);

ALTER TABLE ONLY public.orders
    ALTER COLUMN id
    SET DEFAULT nextval('public.orders_id_seq'::regclass);

ALTER TABLE ONLY public.restaurants
    ALTER COLUMN id
    SET DEFAULT nextval('public.restaurants_id_seq'::regclass);

ALTER TABLE ONLY public.users
    ALTER COLUMN id
    SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Primary Keys
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.menu_item_ingredients
    ADD CONSTRAINT menu_item_ingredients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Unique Constraints
--

ALTER TABLE ONLY public.menu_item_ingredients
    ADD CONSTRAINT unique_menu_inventory
    UNIQUE (menu_item_id, inventory_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key
    UNIQUE (username);


--
-- Foreign Keys
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT fk_inventory_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants(id);

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT fk_inventory_transaction
    FOREIGN KEY (inventory_id)
    REFERENCES public.inventory_items(id);

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT fk_menu_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants(id);

ALTER TABLE ONLY public.menu_item_ingredients
    ADD CONSTRAINT fk_recipe_inventory
    FOREIGN KEY (inventory_id)
    REFERENCES public.inventory_items(id)
    ON DELETE CASCADE;

ALTER TABLE ONLY public.menu_item_ingredients
    ADD CONSTRAINT fk_recipe_menu_item
    FOREIGN KEY (menu_item_id)
    REFERENCES public.menu_items(id)
    ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_restaurant
    FOREIGN KEY (restaurant_id)
    REFERENCES public.restaurants(id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_menu_item_id_fkey
    FOREIGN KEY (menu_item_id)
    REFERENCES public.menu_items(id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey
    FOREIGN KEY (order_id)
    REFERENCES public.orders(id);


--
-- PostgreSQL database schema complete
--

\unrestrict 3yuQVrE53dktVYKIwKnJXqefWComFotgMmfR55Bnlus9EoYuS7oT66wSFwxGfej