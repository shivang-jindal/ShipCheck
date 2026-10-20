import { Link } from 'react-router-dom';

import { Button, Card, EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <EmptyState
          title="Page not found"
          description="That address does not match anything in ShipCheck. Check the link, or go back to the dashboard."
          action={
            <Link to="/">
              <Button variant="primary">Go to ShipCheck</Button>
            </Link>
          }
        />
      </Card>
    </div>
  );
}