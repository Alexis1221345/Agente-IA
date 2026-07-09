export interface DaySchedule {
  open: string;  // "HH:MM" 24h
  close: string; // "HH:MM" 24h
}

export interface RestaurantConfig {
  id: string;
  phoneNumberId?: string;  // Meta phone_number_id for routing (multi-tenant)
  name: string;
  timezone: string;            // IANA, e.g. "America/Mexico_City"
  schedule: Record<string, DaySchedule | null>; // "monday"..."sunday", null = closed
  slotDurationMinutes: number; // e.g. 90
  capacityPerSlot: number;     // total covers per time slot
  bookableQuota: number;       // fraction the bot can book, e.g. 0.8 (80%)
  maxAutoGroupSize: number;    // above this → escalate to human
  humanPhone: string;
  calendarId: string;          // Google Calendar ID
  googleCredentialsPath?: string; // path to service account JSON for this restaurant
  cancellationPolicy: string;  // shown to customer on confirm
  faq: Record<string, string>; // question pattern → answer
  sheetsId?: string;           // Google Sheets ID for the menu
  menuWebUrl?: string;         // public URL where customers can browse the menu
  websiteUrl?: string;         // restaurant's main website URL (shown after confirmations)
  crmWebhookUrl?: string;      // optional webhook URL to push orders/reservations to the restaurant's CRM
  gbpAccountId?: string;       // Google Business Profile account ID (auto-reply to Google reviews)
  gbpLocationId?: string;      // Google Business Profile location ID (auto-reply to Google reviews)
  reviewsEnabled?: boolean;    // enable automatic replies to Google reviews
  reviewsTone?: string;        // extra per-restaurant instructions for review replies
  reviewsPollMinutes?: number; // how often to check for new reviews (per restaurant)
}
