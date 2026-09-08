# Dashboard database setup in PocketBase

Data is split **by category** into separate collections. Each time the admin changes something, the app **creates new records** (append-only); when loading, the **latest** record per key is used. No JSON blobs—every field is a proper type. Multi-kiosk: every collection has `kiosk_id`.

## 1. Open PocketBase Admin

1. Run PocketBase: `.\pocketbase.exe serve`
2. Go to **http://127.0.0.1:8090/_/**
3. Log in with your admin account.

## 2. Create the collections

Create **5 collections** (Collections → New collection). For each collection, add the fields below. **Keep PocketBase’s default fields** (`id`, `created`, `updated`)—do not delete them; the app uses `created` to pick the latest record per key. Set **API rules** to **Admin only** (List, View, Create, Update).

---

### template_sales (Sales by Template)

| Field name      | Type   | Notes                                            |
| --------------- | ------ | ------------------------------------------------ |
| `kiosk_id`      | Text   | Required                                         |
| `template_id`   | Text   | Required                                         |
| `template_name` | Text   | Optional; template name for display in DB        |
| `pieces_sold`   | Number | Required                                         |
| `total_sales`   | Number | Required; pieces_sold × template price (revenue) |

Date is derived from PocketBase default `created` (YYYY-MM-DD).

---

### template_prices (Prices per template)

| Field name      | Type   | Notes                                     |
| --------------- | ------ | ----------------------------------------- |
| `kiosk_id`      | Text   | Required                                  |
| `template_id`   | Text   | Required                                  |
| `template_name` | Text   | Optional; template name for display in DB |
| `price`         | Number | Required                                  |

---

### reprint_sales (Reprint: pieces + total per day)

| Field name    | Type   | Notes    |
| ------------- | ------ | -------- |
| `kiosk_id`    | Text   | Required |
| `pieces_sold` | Number | Required |
| `total_sales` | Number | Required |

Date is derived from PocketBase default `created` (YYYY-MM-DD).

---

### custom_items (Custom items: item_name + price, e.g. Keychain, Mug)

| Field name  | Type   | Notes                        |
| ----------- | ------ | ---------------------------- |
| `kiosk_id`  | Text   | Required                     |
| `item_id`   | Text   | Required (item_1, item_2, …) |
| `item_name` | Text   | Required                     |
| `price`     | Number | Required                     |

---

### custom_sales (Custom item pieces per day)

| Field name    | Type   | Notes                                        |
| ------------- | ------ | -------------------------------------------- |
| `kiosk_id`    | Text   | Required                                     |
| `item_id`     | Text   | Required                                     |
| `item_name`   | Text   | Optional; denormalized item name             |
| `pieces_sold` | Number | Required                                     |
| `total_sales` | Number | Required; pieces_sold × item price (revenue) |

Date is derived from PocketBase default `created` (YYYY-MM-DD).

---

## 3. API rules

For **each** of the 5 collections:

1. Open the collection → **API Rules**.
2. Set **List**, **View**, **Create**, and **Update** to **Admin only** (locked).

No need to create records manually—the app creates them when the admin saves.

## 4. Per-kiosk config

On each kiosk set in `.env`:

```env
VITE_KIOSK_ID=booth-1
```

Use a different value per device. For a single kiosk omit or use `default`.

## 5. How it works

- **Sync on open:** When you open the admin panel and are logged in, the app **first pushes** whatever is in localStorage (current device state) to PocketBase, then loads from PocketBase. So PocketBase stays in sync with local data.
- **Load:** The app fetches all records for the current kiosk from each collection, sorts by newest first, and uses the **latest** value per logical key (e.g. latest per template+date, latest per template for price).
- **Save:** Each time the admin changes data and it’s saved, the app **creates new records** (no updates). So you get a history of changes; “current” state is the latest record per key.
- **Categories:** Sales by template, template prices, reprint sales (pieces + total per day; no single reprint price—prices can differ by template), custom items, and custom item sales are stored in their own collections. Keychain is tracked as a custom item if you add it.

If PocketBase is unavailable, the app still uses localStorage on that device.
