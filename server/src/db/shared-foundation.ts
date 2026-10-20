/** Types shared between the database schema and the server services. */

export interface CustomerAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
}