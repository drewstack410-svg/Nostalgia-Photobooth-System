/// <reference path="../pb_data/types.d.ts" />

function exists(app, name) {
  try {
    app.findCollectionByNameOrId(name);
    return true;
  } catch {
    return false;
  }
}

function text(name, required) {
  return { name, type: "text", required: !!required };
}

function number(name) {
  return { name, type: "number", required: true };
}

migrate((app) => {
  const specs = [
    {
      name: "template_sales",
      fields: [
        text("kiosk_id", true),
        text("template_id", true),
        text("template_name", false),
        number("pieces_sold"),
        number("total_sales"),
      ],
    },
    {
      name: "template_prices",
      fields: [
        text("kiosk_id", true),
        text("template_id", true),
        text("template_name", false),
        number("price"),
      ],
    },
    {
      name: "reprint_sales",
      fields: [text("kiosk_id", true), number("pieces_sold"), number("total_sales")],
    },
    {
      name: "custom_items",
      fields: [
        text("kiosk_id", true),
        text("item_id", true),
        text("item_name", true),
        number("price"),
      ],
    },
    {
      name: "custom_sales",
      fields: [
        text("kiosk_id", true),
        text("item_id", true),
        text("item_name", false),
        number("pieces_sold"),
        number("total_sales"),
      ],
    },
  ];

  for (const spec of specs) {
    if (exists(app, spec.name)) continue;
    const collection = new Collection({
      type: "base",
      name: spec.name,
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: spec.fields,
    });
    app.save(collection);
  }
});
