export interface FieldDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
}
export interface EntityDef {
  name: string;
  fields: FieldDef[];
}

/** Generated from the Application Blueprint. */
export const ENTITIES: EntityDef[] = [
  {
    "name": "Booking",
    "fields": [
      {
        "name": "guestName",
        "type": "string",
        "required": true
      },
      {
        "name": "partySize",
        "type": "number",
        "required": true
      },
      {
        "name": "date",
        "type": "string",
        "required": true
      }
    ]
  }
];

export const routeFor = (e: EntityDef): string => `${e.name.toLowerCase()}s`;
