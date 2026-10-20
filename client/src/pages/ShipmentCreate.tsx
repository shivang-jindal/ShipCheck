/** Create a shipment by hand. Carriers are optional and never implied. */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { CARRIER_CATALOGUE, createShipmentSchema } from '@shipcheck/shared';

import { api, ApiError } from '../lib/api';
import { usePermission, useSession } from '../lib/session';
import { Button, Card, Field, Input, PageHeader, Select, Textarea } from '../components/ui';

const EMPTY = {
  trackingNumber: '',
  carrierCode: 'manual',
  orderReference: '',
  publicReference: '',
  customerName: '',
  customerEmail: '',
  destinationCountry: '',
  shippedAt: '',
  estimatedDeliveryAt: '',
  internalNotes: '',
};

export function ShipmentCreatePage() {
  const { activeOrganizationId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreate = usePermission('shipment.create');

  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = createShipmentSchema.safeParse({
        trackingNumber: form.trackingNumber,
        carrierCode: form.carrierCode,
        orderReference: form.orderReference.trim() || null,
        publicReference: form.publicReference.trim() || null,
        customerName: form.customerName.trim() || null,
        customerEmail: form.customerEmail.trim() || null,
        destinationCountry: form.destinationCountry.trim().toUpperCase() || null,
        shippedAt: form.shippedAt || null,
        estimatedDeliveryAt: form.estimatedDeliveryAt || null,
        internalNotes: form.internalNotes.trim() || null,
      });
      if (!parsed.success) {
        setErrors(
          Object.fromEntries(
            parsed.error.issues.map((issue) => [issue.path.join('.'), [issue.message]]),
          ),
        );
        throw new ApiError(400, {
          error: { code: 'VALIDATION_ERROR', message: 'Check the highlighted fields.', requestId: '' },
        }, 'Check the highlighted fields.');
      }
      return api.post<{ shipment: { id: string }; publicUrl: string }>(
        `/${activeOrganizationId}/shipments`,
        parsed.data,
      );
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries();
      navigate(`/${activeOrganizationId}/shipments/${created.shipment.id}`, {
        replace: true,
        state: { publicUrl: created.publicUrl },
      });
    },
  });

  if (!canCreate) {
    return (
      <>
        <PageHeader title="Add shipment" />
        <Card>
          <p className="text-[13px] text-ink-muted">
            Your role does not allow adding shipments. Ask an admin or the owner for the
            <code className="mx-1">shipment.create</code> permission.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Add shipment"
        description="ShipCheck starts a shipment in “Label created” and waits for a carrier event. It does not contact the carrier."
      />

      <Card className="max-w-3xl">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setErrors({});
            mutation.mutate();
          }}
        >
          {mutation.error instanceof ApiError ? (
            <p
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]"
            >
              {mutation.error.message}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Tracking number"
              required
              error={errors.trackingNumber?.[0]}
              hint="Exactly as the carrier shows it. Must be unique per carrier."
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.trackingNumber}
                  onChange={(event) => setForm({ ...form, trackingNumber: event.target.value })}
                  required
                />
              )}
            </Field>

            <Field
              label="Carrier"
              error={errors.carrierCode?.[0]}
              hint="Choose “Manual / unknown carrier” if you do not know it yet."
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.carrierCode}
                  onChange={(event) => setForm({ ...form, carrierCode: event.target.value })}
                >
                  {CARRIER_CATALOGUE.map((carrier) => (
                    <option key={carrier.code} value={carrier.code}>
                      {carrier.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Order reference" error={errors.orderReference?.[0]} hint="Your own reference. Internal only.">
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.orderReference}
                  onChange={(event) => setForm({ ...form, orderReference: event.target.value })}
                />
              )}
            </Field>

            <Field
              label="Public reference"
              error={errors.publicReference?.[0]}
              hint="Shown to the customer on the tracking page instead of internal notes."
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.publicReference}
                  onChange={(event) => setForm({ ...form, publicReference: event.target.value })}
                />
              )}
            </Field>

            <Field label="Customer name" error={errors.customerName?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.customerName}
                  onChange={(event) => setForm({ ...form, customerName: event.target.value })}
                />
              )}
            </Field>

            <Field label="Customer email" error={errors.customerEmail?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="email"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.customerEmail}
                  onChange={(event) => setForm({ ...form, customerEmail: event.target.value })}
                />
              )}
            </Field>

            <Field label="Destination country" error={errors.destinationCountry?.[0]} hint="Two-letter ISO code.">
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  maxLength={2}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.destinationCountry}
                  onChange={(event) =>
                    setForm({ ...form, destinationCountry: event.target.value.toUpperCase() })
                  }
                />
              )}
            </Field>

            <Field label="Shipped on" error={errors.shippedAt?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="date"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.shippedAt}
                  onChange={(event) => setForm({ ...form, shippedAt: event.target.value })}
                />
              )}
            </Field>

            <Field
              label="Estimated delivery"
              error={errors.estimatedDeliveryAt?.[0]}
              hint="Your estimate. ShipCheck never presents this as a carrier commitment."
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="date"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.estimatedDeliveryAt}
                  onChange={(event) => setForm({ ...form, estimatedDeliveryAt: event.target.value })}
                />
              )}
            </Field>
          </div>

          <Field label="Internal notes" error={errors.internalNotes?.[0]} hint="Never shown on a public tracking page.">
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                invalid={invalid}
                value={form.internalNotes}
                onChange={(event) => setForm({ ...form, internalNotes: event.target.value })}
              />
            )}
          </Field>

          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={mutation.isPending}>
              Add shipment
            </Button>
            <Button variant="ghost" onClick={() => navigate(`/${activeOrganizationId}/shipments`)}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}