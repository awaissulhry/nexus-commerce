# Nexus Commerce Dashboard

A modern e-commerce dashboard built with Next.js 14, React, Tailwind CSS, and Prisma ORM.

## Features

- **Dashboard Home**: Displays key metrics including total products and orders
- **Orders Page**: View all orders in a clean, organized table with order details
- **Catalog Page**: Placeholder for product catalog management
- **Responsive Sidebar Navigation**: Easy navigation between dashboard sections
- **Server-Side Rendering**: Direct Prisma database access from server components
- **TypeScript**: Full type safety across the application

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Styling**: Tailwind CSS
- **Language**: TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Package Manager**: npm (monorepo with Turbo)

## Project Structure

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout with sidebar navigation
│   │   ├── page.tsx            # Dashboard home page
│   │   ├── globals.css         # Global styles
│   │   ├── catalog/
│   │   │   └── page.tsx        # Catalog page (placeholder)
│   │   └── orders/
│   │       └── page.tsx        # Orders listing page
│   └── components/
│       └── StatCard.tsx        # Reusable statistics card component
├── next.config.js              # Next.js configuration
├── tsconfig.json               # TypeScript configuration
├── tailwind.config.ts          # Tailwind CSS configuration
├── postcss.config.js           # PostCSS configuration
├── .env.example                # Environment variables template
└── package.json                # Dependencies and scripts
```

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database
- npm or yarn

### Installation

1. **Install dependencies** (from monorepo root):
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   ```bash
   cp apps/web/.env.example apps/web/.env.local
   ```
   
   Update `apps/web/.env.local` with your database connection:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/nexus_commerce
   ```

3. **Run the development server**:
   ```bash
   npm run dev
   ```
   
   The dashboard will be available at `http://localhost:3000`

### Building for Production

```bash
npm run build
npm start
```

## Pages

### Dashboard Home (`/`)
- Displays total product count
- Displays total order count
- Shows quick statistics about the platform
- Uses Prisma to query the database in real-time

### Orders (`/orders`)
- Lists all orders from the database
- Shows order details: ID, Amazon Order ID, channel, status, total amount, item count, and creation date
- Status badges with color coding (completed, pending, cancelled)
- Currency formatting for order amounts
- Responsive table layout

### Catalog (`/catalog`)
- Placeholder page for future product catalog management
- Ready to be extended with product listing and management features

## Components

### StatCard
A reusable component for displaying statistics with:
- Title and numeric value
- Icon emoji
- Color-coded styling (blue, green, red, purple)
- Responsive design

## Database Integration

The dashboard connects directly to the PostgreSQL database using Prisma ORM through the `@nexus/database` package. All pages use Next.js Server Components for secure, server-side database queries.

### Key Models Used:
- **Product**: Tracks inventory items
- **Order**: Stores customer orders
- **OrderItem**: Individual items within orders
- **Channel**: Sales channels (e.g., Amazon)

## Styling

The application uses Tailwind CSS for styling with a clean, modern design:
- Dark sidebar navigation
- Light gray background
- Color-coded status badges
- Responsive grid layouts
- Hover effects and transitions

## Development

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run linting

### Code Style

- TypeScript for type safety
- React Server Components for optimal performance
- Tailwind CSS for styling
- Semantic HTML structure

## Environment Variables

Create an `.env.local` file in the `apps/web` directory:

```env
# Database connection string
DATABASE_URL=postgresql://user:password@localhost:5432/nexus_commerce
```

## Notes

- The dashboard uses dynamic rendering (`export const dynamic = 'force-dynamic'`) for pages that fetch real-time data from the database
- All database queries are performed server-side for security and performance
- The sidebar navigation is fixed and always visible on desktop
- The application is fully responsive and works on mobile devices

## Future Enhancements

- Add authentication and authorization
- Implement order filtering and search
- Add product management features
- Create analytics and reporting pages
- Add real-time notifications
- Implement data export functionality

## Support

For issues or questions, please refer to the main project documentation or contact the development team.
