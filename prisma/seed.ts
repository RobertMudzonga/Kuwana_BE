/**
 * Sosa Connect — Database Seed
 * Run: npm run db:seed
 *
 * Creates:
 *  - 1 admin user
 *  - 3 general users
 *  - 3 approved service providers (with Harare coordinates)
 *  - Service listings per provider
 *  - Emergency contacts (Zimbabwe)
 */

import { PrismaClient, UserRole, UserStatus, ApprovalStatus, ServiceCategory } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Sosa Connect database...\n');

  const saltRounds = 12;

  // ── Admin ─────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@sosaconnect.zw';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'Admin@Sosa2024!';

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, saltRounds),
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      emailVerified: true,
      profile: { create: { fullName: 'Sosa Admin', city: 'Harare', country: 'ZW' } },
    },
  });
  console.log(`✅ Admin: ${admin.email}`);

  // ── General Users ─────────────────────────────────────────
  const users = await Promise.all([
    prisma.user.upsert({
      where: { email: 'amara.moyo@example.zw' },
      update: {},
      create: {
        email: 'amara.moyo@example.zw',
        phone: '+263771234567',
        passwordHash: await bcrypt.hash('User@1234!', saltRounds),
        role: UserRole.USER,
        emailVerified: true,
        profile: { create: { fullName: 'Amara Moyo', city: 'Harare', country: 'ZW', lat: -17.8252, lng: 31.0335 } },
      },
    }),
    prisma.user.upsert({
      where: { email: 'tendai.chikwanda@example.zw' },
      update: {},
      create: {
        email: 'tendai.chikwanda@example.zw',
        phone: '+263772345678',
        passwordHash: await bcrypt.hash('User@1234!', saltRounds),
        role: UserRole.USER,
        emailVerified: true,
        profile: { create: { fullName: 'Tendai Chikwanda', city: 'Bulawayo', country: 'ZW', lat: -20.1500, lng: 28.5833 } },
      },
    }),
    prisma.user.upsert({
      where: { email: 'grace.mutasa@example.zw' },
      update: {},
      create: {
        email: 'grace.mutasa@example.zw',
        passwordHash: await bcrypt.hash('User@1234!', saltRounds),
        role: UserRole.USER,
        emailVerified: true,
        profile: { create: { fullName: 'Grace Mutasa', city: 'Mutare', country: 'ZW', lat: -18.9707, lng: 32.6709 } },
      },
    }),
  ]);
  console.log(`✅ General users: ${users.map((u) => u.email).join(', ')}`);

  // ── Service Provider Users + Providers ────────────────────
  const providerData = [
    {
      email: 'emmanuel.k@example.zw',
      fullName: 'Emmanuel Khumalo',
      businessName: 'Emmanuel\'s Auto Parts',
      category: ServiceCategory.GOODS,
      city: 'Avondale, Harare',
      lat: -17.7968,
      lng: 30.9992,
      description: 'Quality second-hand and new auto parts for all vehicle makes.',
      phone: '+263773456789',
      services: [
        { title: 'Honda Fit Engine', price: 1200, unit: 'each', category: ServiceCategory.GOODS },
        { title: 'Toyota Corolla Gearbox', price: 850, unit: 'each', category: ServiceCategory.GOODS },
        { title: 'Vehicle Diagnosis', price: 15, unit: 'per session', category: ServiceCategory.SERVICES },
      ],
    },
    {
      email: 'johns.services@example.zw',
      fullName: 'John Sithole',
      businessName: 'John\'s Plumbing & Electrical',
      category: ServiceCategory.SERVICES,
      city: 'Borrowdale, Harare',
      lat: -17.7556,
      lng: 31.0875,
      description: 'Professional plumbing and electrical services. Available 24/7 for emergencies.',
      phone: '+263774567890',
      services: [
        { title: 'Emergency Plumbing', price: 100, unit: 'per hour', category: ServiceCategory.SERVICES },
        { title: 'Electrical Fault Finding', price: 80, unit: 'per hour', category: ServiceCategory.SERVICES },
        { title: 'Geyser Installation', price: 250, unit: 'per job', category: ServiceCategory.SERVICES },
      ],
    },
    {
      email: 'sosa.wholesale@example.zw',
      fullName: 'Rutendo Sosa',
      businessName: 'Sosa Wholesale Groceries',
      category: ServiceCategory.FOOD,
      city: 'CBD, Harare',
      lat: -17.8292,
      lng: 31.0522,
      description: 'Wholesale groceries and household goods. Bulk orders available. Delivery in Harare.',
      phone: '+263775678901',
      services: [
        { title: '20L Cooking Oil', price: 28, unit: 'per 20L', category: ServiceCategory.FOOD },
        { title: 'Rice (50kg bag)', price: 45, unit: 'per bag', category: ServiceCategory.FOOD },
        { title: 'Grocery Delivery (Harare CBD)', price: 5, unit: 'per delivery', category: ServiceCategory.DELIVERY },
      ],
    },
  ];

  for (const pd of providerData) {
    const providerUser = await prisma.user.upsert({
      where: { email: pd.email },
      update: {},
      create: {
        email: pd.email,
        phone: pd.phone,
        passwordHash: await bcrypt.hash('Provider@1234!', saltRounds),
        role: UserRole.PROVIDER,
        emailVerified: true,
        profile: { create: { fullName: pd.fullName, city: pd.city, country: 'ZW', lat: pd.lat, lng: pd.lng } },
      },
    });

    const existingProvider = await prisma.provider.findUnique({ where: { userId: providerUser.id } });
    let provider = existingProvider;

    if (!provider) {
      provider = await prisma.provider.create({
        data: {
          userId: providerUser.id,
          businessName: pd.businessName,
          category: pd.category,
          city: pd.city,
          country: 'ZW',
          lat: pd.lat,
          lng: pd.lng,
          description: pd.description,
          phone: pd.phone,
          approvalStatus: ApprovalStatus.APPROVED,
          approvedAt: new Date(),
          approvedBy: admin.id,
          isVerified: true,
          rating: Math.round((3.8 + Math.random() * 1.2) * 10) / 10,
          reviewCount: Math.floor(Math.random() * 50) + 5,
        },
      });

      // Set PostGIS geometry
      await prisma.$executeRawUnsafe(
        `UPDATE providers SET geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography WHERE id = $3`,
        pd.lat,
        pd.lng,
        provider.id,
      );

      // Create service listings
      for (const s of pd.services) {
        await prisma.service.create({
          data: {
            providerId: provider.id,
            title: s.title,
            price: s.price,
            unit: s.unit,
            category: s.category,
            currency: 'USD',
            isActive: true,
          },
        });
      }
    }

    console.log(`✅ Provider: ${pd.businessName}`);
  }

  // ── Emergency Contacts ─────────────────────────────────────
  const emergencyContacts = [
    { label: 'AMBULANCE', phone: '999', category: 'medical', description: 'National Ambulance Service', city: 'Nationwide' },
    { label: 'POLICE', phone: '995', category: 'security', description: 'Zimbabwe Republic Police', city: 'Nationwide' },
    { label: 'FIRE RESCUE', phone: '993', category: 'fire', description: 'Fire & Rescue Services', city: 'Nationwide' },
    { label: 'HARARE HOSPITAL', phone: '+263242700000', category: 'medical', description: 'Parirenyatwa Group of Hospitals', city: 'Harare', lat: -17.8154, lng: 31.0495 },
    { label: 'BULAWAYO HOSPITAL', phone: '+263292240111', category: 'medical', description: 'Mpilo Central Hospital', city: 'Bulawayo', lat: -20.1608, lng: 28.5862 },
    { label: 'TOWING (ZTA)', phone: '+263242700070', category: 'towing', description: 'Zimbabwe Traffic Authority', city: 'Harare' },
  ];

  for (const contact of emergencyContacts) {
    await prisma.emergencyContact.upsert({
      where: { id: `seed_${contact.label.replace(/\s/g, '_')}` },
      update: {},
      create: {
        id: `seed_${contact.label.replace(/\s/g, '_')}`,
        ...contact,
        isActive: true,
      },
    });
  }
  console.log(`✅ Emergency contacts: ${emergencyContacts.length} seeded`);

  console.log('\n🎉 Seed complete!');
  console.log(`\nAdmin login: ${adminEmail} / ${adminPassword}`);
  console.log('Provider login: emmanuel.k@example.zw / Provider@1234!');
  console.log('User login:     amara.moyo@example.zw / User@1234!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
