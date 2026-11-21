/**
 * Marketplace seed (Phase 1): cities, hubs, pickup points, exchange rates,
 * categories, brands, sellers, catalog products and competing offers.
 *
 * Idempotent: everything is upserted by a natural key, so re-running only fills gaps.
 * Pickup point and hub locations are development placeholders, not real partner sites.
 *
 * The offers are arranged to exercise the Buy Box:
 *  - SAM-A15:    a cheaper seller-fulfilled offer loses to hub stock; a pending seller's cheapest offer is ignored
 *  - TEC-SPARK20: Bulawayo-hub offer wins nationally, Harare-hub offer wins for Harare buyers
 *  - ITL-A70:    two seller-fulfilled offers decided by landed price (price + shipping)
 *  - LEN-IP1:    the 1P offer is sold out, so the in-stock 3P offer wins
 *  - OLV-OIL2L:  the same 1P product stocked in two hubs
 *  - SAM-55CU:   only a sold-out offer, so the product shows as out of stock
 */
import { PrismaClient, Prisma, DeliveryZone, PickupPointType, SellerKycTier, ApprovalStatus, FulfilmentMethod, VehicleClass } from '@prisma/client';
import { DEFAULT_HOURS, OperatingHours } from '../src/lib/opening-hours';
import bcrypt from 'bcryptjs';

type CitySeed = { name: string; province: string; zone: DeliveryZone; cod: boolean; lat: number; lng: number; suburbs: string[] };

const CITIES: CitySeed[] = [
  { name: 'Harare', province: 'Harare', zone: 'METRO', cod: true, lat: -17.8292, lng: 31.0522, suburbs: ['Avondale', 'Avonlea', 'Belvedere', 'Borrowdale', 'Budiriro', 'CBD', 'Dzivarasekwa', 'Eastlea', 'Glen View', 'Greendale', 'Hatfield', 'Highfield', 'Highlands', 'Kuwadzana', 'Mabelreign', 'Mabvuku', 'Marlborough', 'Mbare', 'Mount Pleasant', 'Msasa', 'Southerton', 'Tafara', 'Warren Park', 'Waterfalls', 'Westgate', 'Workington'] },
  { name: 'Bulawayo', province: 'Bulawayo', zone: 'METRO', cod: true, lat: -20.1325, lng: 28.6265, suburbs: ['Belmont', 'Bradfield', 'Burnside', 'CBD', 'Cowdray Park', 'Entumbane', 'Famona', 'Hillside', 'Kumalo', 'Luveve', 'Magwegwe', 'Mpopoma', 'Nketa', 'Nkulumane', 'Pumula', 'Romney Park', 'Selbourne Park', 'Suburbs'] },
  { name: 'Chitungwiza', province: 'Harare', zone: 'METRO', cod: false, lat: -18.0127, lng: 31.0756, suburbs: ['Seke', 'St Mary\'s', 'Unit L', 'Zengeza'] },
  { name: 'Mutare', province: 'Manicaland', zone: 'INTERCITY', cod: false, lat: -18.9707, lng: 32.6709, suburbs: ['CBD', 'Chikanga', 'Dangamvura', 'Fern Valley', 'Greenside', 'Murambi', 'Sakubva'] },
  { name: 'Gweru', province: 'Midlands', zone: 'INTERCITY', cod: false, lat: -19.45, lng: 29.8167, suburbs: ['Ascot', 'CBD', 'Mambo', 'Mkoba', 'Senga', 'Southview'] },
  { name: 'Kwekwe', province: 'Midlands', zone: 'INTERCITY', cod: false, lat: -18.9281, lng: 29.8149, suburbs: ['Amaveni', 'CBD', 'Mbizo', 'Newtown'] },
  { name: 'Masvingo', province: 'Masvingo', zone: 'INTERCITY', cod: false, lat: -20.0744, lng: 30.8328, suburbs: ['CBD', 'Eastvale', 'Mucheke', 'Rujeko'] },
  { name: 'Kadoma', province: 'Mashonaland West', zone: 'INTERCITY', cod: false, lat: -18.3333, lng: 29.9167, suburbs: [] },
  { name: 'Chinhoyi', province: 'Mashonaland West', zone: 'INTERCITY', cod: false, lat: -17.3667, lng: 30.2, suburbs: [] },
  { name: 'Marondera', province: 'Mashonaland East', zone: 'INTERCITY', cod: false, lat: -18.1853, lng: 31.5519, suburbs: [] },
  { name: 'Bindura', province: 'Mashonaland Central', zone: 'INTERCITY', cod: false, lat: -17.3019, lng: 31.3306, suburbs: [] },
  { name: 'Rusape', province: 'Manicaland', zone: 'INTERCITY', cod: false, lat: -18.5278, lng: 32.1283, suburbs: [] },
  { name: 'Victoria Falls', province: 'Matabeleland North', zone: 'INTERCITY', cod: false, lat: -17.9243, lng: 25.8572, suburbs: [] },
  { name: 'Hwange', province: 'Matabeleland North', zone: 'INTERCITY', cod: false, lat: -18.3667, lng: 26.5, suburbs: [] },
  { name: 'Gwanda', province: 'Matabeleland South', zone: 'INTERCITY', cod: false, lat: -20.9333, lng: 29.0, suburbs: [] },
  { name: 'Beitbridge', province: 'Matabeleland South', zone: 'INTERCITY', cod: false, lat: -22.2167, lng: 30.0, suburbs: [] },
  { name: 'Kariba', province: 'Mashonaland West', zone: 'INTERCITY', cod: false, lat: -16.5167, lng: 28.8, suburbs: [] },
  { name: 'Chiredzi', province: 'Masvingo', zone: 'INTERCITY', cod: false, lat: -21.05, lng: 31.6667, suburbs: [] },
];

/** Approximate suburb centres (development placeholders) for distance when a buyer has no GPS pin */
const SUBURB_COORDS: Record<string, Record<string, [number, number]>> = {
  Harare: {
    Avondale: [-17.799, 31.038], Avonlea: [-17.770, 31.020], Belvedere: [-17.832, 31.020], Borrowdale: [-17.757, 31.092],
    Budiriro: [-17.896, 30.930], CBD: [-17.831, 31.047], Dzivarasekwa: [-17.800, 30.920], Eastlea: [-17.825, 31.070],
    'Glen View': [-17.905, 30.970], Greendale: [-17.817, 31.117], Hatfield: [-17.874, 31.095], Highfield: [-17.879, 31.000],
    Highlands: [-17.800, 31.087], Kuwadzana: [-17.833, 30.920], Mabelreign: [-17.786, 31.011], Mabvuku: [-17.838, 31.170],
    Marlborough: [-17.752, 31.010], Mbare: [-17.859, 31.038], 'Mount Pleasant': [-17.770, 31.049], Msasa: [-17.837, 31.118],
    Southerton: [-17.860, 31.015], Tafara: [-17.830, 31.160], 'Warren Park': [-17.835, 30.980], Waterfalls: [-17.888, 31.041],
    Westgate: [-17.781, 30.985], Workington: [-17.858, 31.008],
  },
  Bulawayo: {
    Belmont: [-20.170, 28.570], Bradfield: [-20.162, 28.605], Burnside: [-20.190, 28.615], CBD: [-20.150, 28.585],
    'Cowdray Park': [-20.095, 28.520], Entumbane: [-20.135, 28.545], Famona: [-20.168, 28.600], Hillside: [-20.175, 28.605],
    Kumalo: [-20.155, 28.600], Luveve: [-20.115, 28.530], Magwegwe: [-20.130, 28.530], Mpopoma: [-20.145, 28.550],
    Nketa: [-20.195, 28.545], Nkulumane: [-20.190, 28.530], Pumula: [-20.130, 28.510], 'Romney Park': [-20.110, 28.570],
    'Selbourne Park': [-20.155, 28.565], Suburbs: [-20.143, 28.600],
  },
  Chitungwiza: { Seke: [-18.000, 31.070], "St Mary's": [-17.990, 31.060], 'Unit L': [-18.030, 31.080], Zengeza: [-18.010, 31.060] },
  Mutare: { CBD: [-18.970, 32.670], Chikanga: [-18.950, 32.640], Dangamvura: [-19.000, 32.620], Sakubva: [-18.990, 32.650] },
};

const HUBS = [
  { code: 'HRE-WKT', name: 'Harare Workington Hub', city: 'Harare', suburb: 'Workington', address: 'Workington Industrial Area, Harare', lat: -17.858, lng: 31.008 },
  { code: 'HRE-MSA', name: 'Harare Msasa Hub', city: 'Harare', suburb: 'Msasa', address: 'Msasa Industrial Area, Harare', lat: -17.843, lng: 31.115 },
  { code: 'BYO-BLM', name: 'Bulawayo Belmont Hub', city: 'Bulawayo', suburb: 'Belmont', address: 'Belmont Industrial Area, Bulawayo', lat: -20.17, lng: 28.57 },
];

/** Map pins for pickup points (development placeholders) */
const PICKUP_COORDS: Record<string, [number, number]> = {
  'PP-HRE-AVD': [-17.7992, 31.0376], 'PP-HRE-BRW': [-17.7565, 31.0915], 'PP-HRE-WGT': [-17.7815, 30.9855], 'PP-HRE-MBR': [-17.8615, 31.0365],
  'PP-CTG-TC': [-18.0105, 31.0745], 'PP-BYO-CBD': [-20.1505, 28.585], 'PP-BYO-NKL': [-20.19, 28.53], 'PP-MUT-CBD': [-18.9705, 32.6705],
  'PP-GWE-CBD': [-19.451, 29.8165], 'PP-MSV-CBD': [-20.0745, 30.833], 'PP-VFA-TWN': [-17.9245, 25.837],
};

const PICKUP_POINTS: { code: string; name: string; type: PickupPointType; city: string; suburb?: string; address: string; landmark?: string; hub: string }[] = [
  { code: 'PP-HRE-AVD', name: 'Avondale Shops counter', type: 'MALL', city: 'Harare', suburb: 'Avondale', address: 'Avondale Shopping Centre, King George Rd', hub: 'HRE-WKT' },
  { code: 'PP-HRE-BRW', name: 'Borrowdale counter', type: 'MALL', city: 'Harare', suburb: 'Borrowdale', address: 'Borrowdale shopping area', hub: 'HRE-MSA' },
  { code: 'PP-HRE-WGT', name: 'Westgate counter', type: 'MALL', city: 'Harare', suburb: 'Westgate', address: 'Westgate shopping area', hub: 'HRE-WKT' },
  { code: 'PP-HRE-MBR', name: 'Mbare Musika depot', type: 'BUS_DEPOT', city: 'Harare', suburb: 'Mbare', address: 'Mbare Musika, Harare', landmark: 'Next to the long-distance bus terminus', hub: 'HRE-WKT' },
  { code: 'PP-CTG-TC', name: 'Chitungwiza Town Centre agent', type: 'PARTNER_SHOP', city: 'Chitungwiza', address: 'Chitungwiza Town Centre', hub: 'HRE-MSA' },
  { code: 'PP-BYO-CBD', name: 'Bulawayo CBD counter', type: 'MALL', city: 'Bulawayo', suburb: 'CBD', address: 'Bulawayo city centre', hub: 'BYO-BLM' },
  { code: 'PP-BYO-NKL', name: 'Nkulumane agent', type: 'PARTNER_SHOP', city: 'Bulawayo', suburb: 'Nkulumane', address: 'Nkulumane shopping centre', hub: 'BYO-BLM' },
  { code: 'PP-MUT-CBD', name: 'Mutare courier depot', type: 'COURIER_DEPOT', city: 'Mutare', suburb: 'CBD', address: 'Mutare city centre', hub: 'HRE-MSA' },
  { code: 'PP-GWE-CBD', name: 'Gweru courier depot', type: 'COURIER_DEPOT', city: 'Gweru', suburb: 'CBD', address: 'Gweru city centre', hub: 'BYO-BLM' },
  { code: 'PP-MSV-CBD', name: 'Masvingo courier depot', type: 'COURIER_DEPOT', city: 'Masvingo', suburb: 'CBD', address: 'Masvingo city centre', hub: 'HRE-WKT' },
  { code: 'PP-VFA-TWN', name: 'Victoria Falls agent', type: 'PARTNER_SHOP', city: 'Victoria Falls', address: 'Victoria Falls town centre', hub: 'BYO-BLM' },
];

/** [slug, name, parentSlug, commission %, fulfilment fee USD, icon] */
const CATEGORIES: [string, string, string | null, number, number, string][] = [
  ['electronics', 'Electronics', null, 8, 2.5, 'smartphone'],
  ['phones-tablets', 'Phones & Tablets', 'electronics', 6, 1.5, 'smartphone'],
  ['laptops-computers', 'Laptops & Computers', 'electronics', 6, 3, 'laptop'],
  ['tv-audio', 'TV & Audio', 'electronics', 8, 4, 'tv'],
  ['solar-power', 'Solar & Backup Power', null, 8, 5, 'sun'],
  ['home-kitchen', 'Home & Kitchen', null, 12, 3, 'home'],
  ['small-appliances', 'Small Appliances', 'home-kitchen', 12, 2.5, 'plug'],
  ['cookware', 'Cookware & Gas', 'home-kitchen', 12, 2, 'flame'],
  ['groceries', 'Groceries & Household', null, 5, 1, 'shopping-basket'],
  ['pantry', 'Pantry Staples', 'groceries', 5, 0.75, 'wheat'],
  ['cleaning', 'Cleaning', 'groceries', 6, 0.5, 'spray-can'],
  ['health-beauty', 'Health & Beauty', null, 12, 1, 'heart'],
  ['baby-kids', 'Baby & Kids', null, 10, 1.5, 'baby'],
];

/** Categories and products too big for a motorbike */
const CATEGORY_VEHICLE: Record<string, VehicleClass> = { 'solar-power': 'CAR' };
const PRODUCT_VEHICLE: Record<string, VehicleClass> = { 'HIS-43A4': 'CAR', 'SAM-55CU': 'CAR', 'JNK-450M': 'BAKKIE' };

const BRANDS = ['Samsung', 'Tecno', 'itel', 'Apple', 'HP', 'Lenovo', 'Hisense', 'JBL', 'Felicity', 'Jinko', 'Russell Hobbs', 'Kenwood', 'Prestige', 'Cadac', 'Olivine', 'Mahatma', 'Blue Ribbon', 'Sunlight', 'Vaseline', 'Huggies'];

type ProductSeed = {
  sku: string; title: string; brand: string; category: string; description: string;
  specs: Record<string, string>; weightKg?: number; rating?: [number, number];
};

const PRODUCTS: ProductSeed[] = [
  { sku: 'SAM-A15', title: 'Samsung Galaxy A15 128GB Dual SIM', brand: 'Samsung', category: 'phones-tablets', rating: [4.5, 212], weightKg: 0.2,
    description: '6.5" Super AMOLED display, 50MP triple camera and a 5000mAh battery that lasts through the day.',
    specs: { Screen: '6.5 in Super AMOLED', Storage: '128 GB', RAM: '4 GB', Battery: '5000 mAh', SIM: 'Dual SIM', Network: '4G LTE' } },
  { sku: 'TEC-SPARK20', title: 'Tecno Spark 20 128GB', brand: 'Tecno', category: 'phones-tablets', rating: [4.3, 158], weightKg: 0.2,
    description: 'Big 6.6" screen, 50MP camera and fast charging at an everyday price.',
    specs: { Screen: '6.6 in', Storage: '128 GB', RAM: '8 GB (4+4 extended)', Battery: '5000 mAh', Charging: '18 W' } },
  { sku: 'ITL-A70', title: 'itel A70 64GB', brand: 'itel', category: 'phones-tablets', rating: [4.0, 97], weightKg: 0.19,
    description: 'Affordable smartphone with a 6.6" display and long battery life.',
    specs: { Screen: '6.6 in', Storage: '64 GB', RAM: '3 GB', Battery: '5000 mAh' } },
  { sku: 'APL-IP13-128', title: 'Apple iPhone 13 128GB', brand: 'Apple', category: 'phones-tablets', rating: [4.8, 64], weightKg: 0.17,
    description: 'A15 Bionic chip, dual-camera system and Super Retina XDR display.',
    specs: { Screen: '6.1 in Super Retina XDR', Storage: '128 GB', Chip: 'A15 Bionic', Network: '5G' } },
  { sku: 'HP-250G9-I5', title: 'HP 250 G9 Laptop, Core i5, 8GB RAM, 512GB SSD', brand: 'HP', category: 'laptops-computers', rating: [4.4, 41], weightKg: 1.74,
    description: 'Reliable 15.6" business laptop with a fast SSD and full-size keyboard.',
    specs: { Processor: 'Intel Core i5-1235U', RAM: '8 GB', Storage: '512 GB SSD', Screen: '15.6 in FHD', OS: 'Windows 11' } },
  { sku: 'LEN-IP1-R5', title: 'Lenovo IdeaPad 1 Ryzen 5, 8GB, 256GB SSD', brand: 'Lenovo', category: 'laptops-computers', rating: [4.2, 33], weightKg: 1.6,
    description: 'Lightweight 15.6" laptop for study and everyday work.',
    specs: { Processor: 'AMD Ryzen 5 7520U', RAM: '8 GB', Storage: '256 GB SSD', Screen: '15.6 in FHD' } },
  { sku: 'HIS-43A4', title: 'Hisense 43" Full HD Smart TV', brand: 'Hisense', category: 'tv-audio', rating: [4.5, 88], weightKg: 6.5,
    description: 'Full HD smart TV with built-in apps, Wi-Fi and three HDMI ports.',
    specs: { Size: '43 in', Resolution: '1920x1080', Smart: 'VIDAA OS', HDMI: '3' } },
  { sku: 'SAM-55CU', title: 'Samsung 55" Crystal UHD 4K Smart TV', brand: 'Samsung', category: 'tv-audio', rating: [4.7, 52], weightKg: 15.4,
    description: 'Crystal-clear 4K picture with HDR and Tizen smart platform.',
    specs: { Size: '55 in', Resolution: '3840x2160', HDR: 'HDR10+', Smart: 'Tizen' } },
  { sku: 'JBL-FLIP6', title: 'JBL Flip 6 Portable Bluetooth Speaker', brand: 'JBL', category: 'tv-audio', rating: [4.8, 120], weightKg: 0.55,
    description: 'Bold sound, IP67 waterproof and dustproof, 12 hours of playtime.',
    specs: { Battery: '12 hours', 'Water resistance': 'IP67', Connectivity: 'Bluetooth 5.1' } },
  { sku: 'FEL-IVEM3024', title: 'Felicity 3kVA 24V Hybrid Solar Inverter', brand: 'Felicity', category: 'solar-power', rating: [4.6, 73], weightKg: 9.8,
    description: 'Pure sine wave hybrid inverter with built-in MPPT charge controller for load-shedding backup.',
    specs: { Capacity: '3 kVA / 2.4 kW', 'System voltage': '24 V', 'Charge controller': 'MPPT 60 A', Waveform: 'Pure sine wave' } },
  { sku: 'JNK-450M', title: 'Jinko 450W Monocrystalline Solar Panel', brand: 'Jinko', category: 'solar-power', rating: [4.7, 59], weightKg: 23.5,
    description: 'High-efficiency mono PERC panel for home and small business solar systems.',
    specs: { Power: '450 W', Type: 'Monocrystalline PERC', Efficiency: '20.8%' } },
  { sku: 'FEL-LPBA24100', title: 'Felicity 24V 100Ah Lithium Battery', brand: 'Felicity', category: 'solar-power', rating: [4.5, 38], weightKg: 22,
    description: 'LiFePO4 battery with built-in BMS, 6000+ cycles.',
    specs: { Voltage: '25.6 V', Capacity: '100 Ah', Chemistry: 'LiFePO4', Cycles: '6000+' } },
  { sku: 'RH-KETTLE17', title: 'Russell Hobbs 1.7L Cordless Kettle', brand: 'Russell Hobbs', category: 'small-appliances', rating: [4.4, 140], weightKg: 1.1,
    description: 'Fast-boil 2200W kettle with auto shut-off.',
    specs: { Capacity: '1.7 L', Power: '2200 W' } },
  { sku: 'KEN-BLP15', title: 'Kenwood 1.5L Blender', brand: 'Kenwood', category: 'small-appliances', rating: [4.3, 61], weightKg: 2.4,
    description: 'Glass jug blender with pulse function and ice-crush blades.',
    specs: { Capacity: '1.5 L', Power: '500 W', Jug: 'Glass' } },
  { sku: 'PRS-PC5L', title: 'Prestige 5L Pressure Cooker', brand: 'Prestige', category: 'cookware', rating: [4.6, 77], weightKg: 2.2,
    description: 'Aluminium pressure cooker that cuts cooking time and saves gas.',
    specs: { Capacity: '5 L', Material: 'Aluminium' } },
  { sku: 'CDC-2PLATE', title: 'Cadac 2-Plate Gas Stove', brand: 'Cadac', category: 'cookware', rating: [4.2, 45], weightKg: 3.1,
    description: 'Portable two-burner LPG stove, ideal during power cuts.',
    specs: { Burners: '2', Fuel: 'LPG' } },
  { sku: 'OLV-OIL2L', title: 'Olivine Cooking Oil 2L', brand: 'Olivine', category: 'pantry', rating: [4.7, 310], weightKg: 2,
    description: 'Pure vegetable cooking oil.',
    specs: { Volume: '2 L' } },
  { sku: 'MHT-RICE10', title: 'Mahatma Long Grain Rice 10kg', brand: 'Mahatma', category: 'pantry', rating: [4.6, 120], weightKg: 10,
    description: 'Long grain parboiled rice.',
    specs: { Weight: '10 kg' } },
  { sku: 'BRB-MEAL10', title: 'Blue Ribbon Roller Meal 10kg', brand: 'Blue Ribbon', category: 'pantry', rating: [4.5, 205], weightKg: 10,
    description: 'Roller meal for sadza.',
    specs: { Weight: '10 kg' } },
  { sku: 'SUN-DISH750', title: 'Sunlight Dishwashing Liquid 750ml', brand: 'Sunlight', category: 'cleaning', rating: [4.6, 98], weightKg: 0.8,
    description: 'Lemon dishwashing liquid that cuts through grease.',
    specs: { Volume: '750 ml' } },
  { sku: 'VAS-IC400', title: 'Vaseline Intensive Care Lotion 400ml', brand: 'Vaseline', category: 'health-beauty', rating: [4.7, 86], weightKg: 0.45,
    description: 'Deep moisture body lotion for dry skin.',
    specs: { Volume: '400 ml' } },
  { sku: 'HUG-DC4-58', title: 'Huggies Dry Comfort Nappies Size 4 (58)', brand: 'Huggies', category: 'baby-kids', rating: [4.6, 132], weightKg: 2.3,
    description: 'Up to 12 hours of dryness. Size 4, 8–14 kg.',
    specs: { Size: '4 (8–14 kg)', Count: '58' } },
];

type SellerSeed = { key: string; email: string; businessName: string; tier: SellerKycTier; status: ApprovalStatus; city: string; sla: number; dispute: number; rating: [number, number]; lead: number; taxNumber?: string; nationalId?: string };

const SELLERS: SellerSeed[] = [
  { key: 'gadgets', email: 'seller.gadgets@example.zw', businessName: 'Harare Gadget Hub', tier: 'REGISTERED', status: 'APPROVED', city: 'Harare', sla: 96, dispute: 1.2, rating: [4.6, 420], lead: 1, taxNumber: '200123456' },
  { key: 'byohome', email: 'seller.byohome@example.zw', businessName: 'Byo Home & Solar', tier: 'REGISTERED', status: 'APPROVED', city: 'Bulawayo', sla: 92, dispute: 2.0, rating: [4.4, 260], lead: 2, taxNumber: '200654321' },
  { key: 'mbare', email: 'seller.mbare@example.zw', businessName: 'Mbare Wholesalers', tier: 'INFORMAL', status: 'APPROVED', city: 'Harare', sla: 85, dispute: 4.5, rating: [4.1, 133], lead: 2, nationalId: '63-1234567-X-63' },
  { key: 'mutare', email: 'seller.mutare@example.zw', businessName: 'Mutare Electronics', tier: 'REGISTERED', status: 'PENDING', city: 'Mutare', sla: 100, dispute: 0, rating: [0, 0], lead: 3, taxNumber: '200999888' },
  { key: 'borrowmart', email: 'seller.borrowmart@example.zw', businessName: 'Borrowdale Fresh Mart', tier: 'REGISTERED', status: 'APPROVED', city: 'Harare', sla: 94, dispute: 1.5, rating: [4.5, 310], lead: 1, taxNumber: '200777111' },
  { key: 'chitown', email: 'seller.chitown@example.zw', businessName: 'Chitungwiza Traders', tier: 'INFORMAL', status: 'APPROVED', city: 'Chitungwiza', sla: 88, dispute: 3.0, rating: [4.2, 95], lead: 1, nationalId: '08-7654321-Y-08' },
];

const EVERY_DAY = (open: string, close: string): OperatingHours =>
  ({ mon: [[open, close]], tue: [[open, close]], wed: [[open, close]], thu: [[open, close]], fri: [[open, close]], sat: [[open, close]], sun: [[open, close]] });

/** Store branches — GPS pins are development placeholders, not real shops */
type BranchSeed = { code: string; seller: string; name: string; city: string; suburb?: string; address: string; landmark?: string; lat: number; lng: number; hours: OperatingHours; prep: number };
const BRANCHES: BranchSeed[] = [
  { code: 'HGH-AVO', seller: 'gadgets', name: 'Avondale', city: 'Harare', suburb: 'Avondale', address: 'Avondale Shopping Centre, King George Rd', landmark: 'Upstairs, next to the bank', lat: -17.7995, lng: 31.0385, hours: DEFAULT_HOURS, prep: 20 },
  { code: 'HGH-CBD', seller: 'gadgets', name: 'City Centre', city: 'Harare', suburb: 'CBD', address: 'First Street Mall', landmark: 'Opposite the post office', lat: -17.8305, lng: 31.048, hours: { ...DEFAULT_HOURS, sat: [['08:00', '13:00']], sun: [] }, prep: 20 },
  { code: 'MW-MBA', seller: 'mbare', name: 'Mbare Musika', city: 'Harare', suburb: 'Mbare', address: 'Mbare Musika, stand 14', landmark: 'Behind the long-distance bus terminus', lat: -17.86, lng: 31.04, hours: EVERY_DAY('06:00', '20:00'), prep: 30 },
  { code: 'BHS-CBD', seller: 'byohome', name: 'Bulawayo City', city: 'Bulawayo', suburb: 'CBD', address: '9th Avenue & Fife Street', lat: -20.151, lng: 28.586, hours: DEFAULT_HOURS, prep: 45 },
  { code: 'BHS-MSA', seller: 'byohome', name: 'Harare Msasa depot', city: 'Harare', suburb: 'Msasa', address: 'Mutare Road, Msasa', landmark: 'Green gate after the Total garage', lat: -17.838, lng: 31.119, hours: DEFAULT_HOURS, prep: 60 },
  { code: 'BFM-BOR', seller: 'borrowmart', name: 'Borrowdale', city: 'Harare', suburb: 'Borrowdale', address: 'Borrowdale Village', landmark: 'Next to the pharmacy', lat: -17.757, lng: 31.0925, hours: EVERY_DAY('07:00', '21:00'), prep: 15 },
  { code: 'CT-ZEN', seller: 'chitown', name: 'Zengeza', city: 'Chitungwiza', suburb: 'Zengeza', address: 'Zengeza 3 shopping centre', lat: -18.01, lng: 31.061, hours: EVERY_DAY('07:00', '19:00'), prep: 25 },
  { code: 'ME-MUT', seller: 'mutare', name: 'Mutare CBD', city: 'Mutare', suburb: 'CBD', address: 'Herbert Chitepo Street', lat: -18.97, lng: 32.67, hours: DEFAULT_HOURS, prep: 40 },
];

/** [sku, branch code, price, stock, listPrice?] — store stock in the zero-warehouse model */
type BranchOfferSeed = [string, string, number, number, number?];
const BRANCH_OFFERS: BranchOfferSeed[] = [
  ['SAM-A15', 'HGH-AVO', 175, 12], ['SAM-A15', 'HGH-CBD', 175, 6], ['SAM-A15', 'MW-MBA', 169, 8], ['SAM-A15', 'BFM-BOR', 182, 5], ['SAM-A15', 'ME-MUT', 150, 30],
  ['TEC-SPARK20', 'HGH-AVO', 145, 8], ['TEC-SPARK20', 'BHS-CBD', 139, 10],
  ['ITL-A70', 'MW-MBA', 79, 40], ['ITL-A70', 'HGH-CBD', 82, 15],
  ['APL-IP13-128', 'HGH-AVO', 549, 3],
  ['HP-250G9-I5', 'HGH-CBD', 629, 6], ['HP-250G9-I5', 'BHS-MSA', 599, 4],
  ['LEN-IP1-R5', 'HGH-AVO', 575, 5], ['LEN-IP1-R5', 'BFM-BOR', 559, 0],
  ['HIS-43A4', 'BHS-MSA', 319, 9], ['HIS-43A4', 'BFM-BOR', 329, 14, 359], ['HIS-43A4', 'BHS-CBD', 319, 6],
  ['SAM-55CU', 'HGH-CBD', 699, 0],
  ['JBL-FLIP6', 'HGH-AVO', 139, 18, 159],
  ['FEL-IVEM3024', 'BHS-CBD', 420, 7], ['FEL-IVEM3024', 'BHS-MSA', 425, 4], ['FEL-IVEM3024', 'MW-MBA', 395, 3],
  ['JNK-450M', 'BHS-CBD', 95, 60], ['JNK-450M', 'BHS-MSA', 99, 40],
  ['FEL-LPBA24100', 'BHS-MSA', 380, 5, 420],
  ['RH-KETTLE17', 'BFM-BOR', 24.99, 50], ['RH-KETTLE17', 'CT-ZEN', 22.5, 12],
  ['KEN-BLP15', 'BFM-BOR', 49, 20], ['KEN-BLP15', 'MW-MBA', 45, 10],
  ['PRS-PC5L', 'MW-MBA', 38, 25],
  ['CDC-2PLATE', 'BHS-CBD', 29, 30], ['CDC-2PLATE', 'CT-ZEN', 31, 10],
  ['OLV-OIL2L', 'BFM-BOR', 5.49, 200], ['OLV-OIL2L', 'MW-MBA', 5.2, 150], ['OLV-OIL2L', 'CT-ZEN', 5.1, 80], ['OLV-OIL2L', 'BHS-CBD', 5.49, 120],
  ['MHT-RICE10', 'BFM-BOR', 12.99, 80], ['MHT-RICE10', 'MW-MBA', 11.5, 60],
  ['BRB-MEAL10', 'MW-MBA', 8.5, 100], ['BRB-MEAL10', 'CT-ZEN', 8.2, 70], ['BRB-MEAL10', 'BFM-BOR', 9.2, 150],
  ['SUN-DISH750', 'BFM-BOR', 2.79, 300], ['SUN-DISH750', 'CT-ZEN', 2.6, 90],
  ['VAS-IC400', 'BFM-BOR', 4.99, 90],
  ['HUG-DC4-58', 'BFM-BOR', 16.49, 45, 18.99], ['HUG-DC4-58', 'BHS-CBD', 15.99, 20],
];

/** Hub stock (used only while hubs are enabled in market settings).
 *  [sku, sellerKey ('1p' = Kuwana Retail), fulfilment, hub code, price, stock, shipping?, listPrice?] */
type OfferSeed = [string, string, FulfilmentMethod, string, number, number, number?, number?];

const OFFERS: OfferSeed[] = [
  ['SAM-A15', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 189, 25],
  ['TEC-SPARK20', 'gadgets', 'PLATFORM_FULFILLED', 'BYO-BLM', 139, 10],
  ['TEC-SPARK20', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 145, 8],
  ['APL-IP13-128', 'gadgets', 'PLATFORM_FULFILLED', 'HRE-MSA', 549, 3],
  ['HP-250G9-I5', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 629, 6],
  ['LEN-IP1-R5', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 559, 0],
  ['HIS-43A4', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 329, 14, 0, 359],
  ['HIS-43A4', 'byohome', 'PLATFORM_FULFILLED', 'BYO-BLM', 319, 9],
  ['SAM-55CU', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 699, 0],
  ['JBL-FLIP6', 'gadgets', 'PLATFORM_FULFILLED', 'HRE-WKT', 139, 18, 0, 159],
  ['FEL-IVEM3024', 'byohome', 'PLATFORM_FULFILLED', 'BYO-BLM', 420, 7],
  ['JNK-450M', '1p', 'PLATFORM_FULFILLED', 'HRE-MSA', 99, 40],
  ['FEL-LPBA24100', 'byohome', 'PLATFORM_FULFILLED', 'BYO-BLM', 380, 5, 0, 420],
  ['RH-KETTLE17', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 24.99, 50],
  ['KEN-BLP15', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 49, 20],
  ['OLV-OIL2L', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 5.49, 200],
  ['OLV-OIL2L', '1p', 'PLATFORM_FULFILLED', 'BYO-BLM', 5.49, 120],
  ['MHT-RICE10', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 12.99, 80],
  ['BRB-MEAL10', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 9.2, 150],
  ['SUN-DISH750', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 2.79, 300],
  ['VAS-IC400', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 4.99, 90],
  ['HUG-DC4-58', '1p', 'PLATFORM_FULFILLED', 'HRE-WKT', 16.49, 45, 0, 18.99],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** Neutral placeholder artwork until real product photos are uploaded */
function placeholderImage(title: string, size: number) {
  const text = encodeURIComponent(title.length > 28 ? `${title.slice(0, 26)}…` : title);
  return `https://placehold.co/${size}x${size}/F1F5F9/334155/png?text=${text}`;
}

export async function seedMarketplace(prisma: PrismaClient, adminUserId: string) {
  // ── Locations ──────────────────────────────────────────
  const cityIds = new Map<string, string>();
  for (const [i, c] of CITIES.entries()) {
    const city = await prisma.city.upsert({
      where: { name: c.name },
      update: {},
      create: { name: c.name, slug: slug(c.name), province: c.province, zone: c.zone, codEligible: c.cod, lat: c.lat, lng: c.lng, sortOrder: i },
    });
    cityIds.set(c.name, city.id);
    if (c.suburbs.length) {
      await prisma.suburb.createMany({ data: c.suburbs.map((name) => ({ cityId: city.id, name })), skipDuplicates: true });
      for (const [name, [lat, lng]] of Object.entries(SUBURB_COORDS[c.name] ?? {})) {
        await prisma.suburb.updateMany({ where: { cityId: city.id, name, lat: null }, data: { lat, lng } });
      }
    }
  }
  const hubIds = new Map<string, string>();
  for (const h of HUBS) {
    const hub = await prisma.hub.upsert({
      where: { code: h.code },
      update: {},
      create: { code: h.code, name: h.name, cityId: cityIds.get(h.city)!, suburb: h.suburb, address: h.address, lat: h.lat, lng: h.lng, operatingHours: 'Mon–Fri 07:30–17:00, Sat 08:00–13:00' },
    });
    hubIds.set(h.code, hub.id);
  }
  for (const p of PICKUP_POINTS) {
    await prisma.pickupPoint.upsert({
      where: { code: p.code },
      update: {},
      create: {
        code: p.code, name: p.name, type: p.type, cityId: cityIds.get(p.city)!, suburb: p.suburb, address: p.address,
        landmark: p.landmark, hubId: hubIds.get(p.hub), agentCommissionRate: 10, operatingHours: 'Mon–Sat 08:00–18:00',
      },
    });
  }
  for (const [code, [lat, lng]] of Object.entries(PICKUP_COORDS)) {
    await prisma.pickupPoint.updateMany({ where: { code, lat: null }, data: { lat, lng } });
  }
  // Pickup points link to their suburb, pay the agent a flat fee per parcel and take a daily cap
  for (const p of PICKUP_POINTS) {
    const sub = p.suburb ? await prisma.suburb.findFirst({ where: { cityId: cityIds.get(p.city)!, name: p.suburb }, select: { id: true } }) : null;
    await prisma.pickupPoint.updateMany({ where: { code: p.code, suburbId: null }, data: { suburbId: sub?.id ?? null } });
    await prisma.pickupPoint.updateMany({ where: { code: p.code, agentFeeUsd: 0, maxDailyParcels: null }, data: { agentFeeUsd: 0.5, maxDailyParcels: 60 } });
  }
  await seedHarareZones(prisma, cityIds.get('Harare')!);
  console.log(`✅ Locations: ${CITIES.length} cities, ${HUBS.length} hubs, ${PICKUP_POINTS.length} pickup points, Harare zones`);

  // ── Exchange rates (development values; set the real rate in admin) ──
  if ((await prisma.exchangeRate.count()) === 0) {
    const day = 24 * 60 * 60 * 1000;
    await prisma.exchangeRate.createMany({
      data: [
        { fromCurrency: 'USD', toCurrency: 'ZWG', rate: new Prisma.Decimal('26.40'), effectiveFrom: new Date(Date.now() - 30 * day), note: 'Seed value', setByAdminId: adminUserId },
        { fromCurrency: 'USD', toCurrency: 'ZWG', rate: new Prisma.Decimal('26.75'), effectiveFrom: new Date(Date.now() - day), note: 'Seed value', setByAdminId: adminUserId },
      ],
    });
  }
  console.log('✅ Exchange rates: USD→ZiG');

  // ── Categories & brands ────────────────────────────────
  const categoryIds = new Map<string, string>();
  for (const [i, [catSlug, name, parent, commission, fee, icon]] of CATEGORIES.entries()) {
    const cat = await prisma.category.upsert({
      where: { slug: catSlug },
      update: {},
      create: { slug: catSlug, name, parentId: parent ? categoryIds.get(parent) : null, commissionRate: commission, fulfilmentFeeUsd: fee, icon, sortOrder: i },
    });
    categoryIds.set(catSlug, cat.id);
    if (CATEGORY_VEHICLE[catSlug]) await prisma.category.update({ where: { id: cat.id }, data: { requiredVehicleClass: CATEGORY_VEHICLE[catSlug] } });
  }
  const brandIds = new Map<string, string>();
  for (const name of BRANDS) {
    const brand = await prisma.brand.upsert({ where: { name }, update: {}, create: { name, slug: slug(name) } });
    brandIds.set(name, brand.id);
  }
  console.log(`✅ Catalog structure: ${CATEGORIES.length} categories, ${BRANDS.length} brands`);

  // ── Sellers ────────────────────────────────────────────
  const sellerIds = new Map<string, string>();
  const firstParty = await prisma.sellerProfile.upsert({
    where: { userId: adminUserId },
    update: {},
    create: {
      userId: adminUserId, businessName: 'Kuwana Retail', slug: 'kuwana-retail', isFirstParty: true,
      kycTier: 'REGISTERED', kycStatus: 'APPROVED', approvedAt: new Date(), cityId: cityIds.get('Harare'),
      slaScore: 98, disputeRate: 0.5, ratingAvg: 4.7, ratingCount: 1520, leadTimeDays: 1,
      description: 'Sold and shipped by Kuwana.',
    },
  });
  sellerIds.set('1p', firstParty.id);

  const sellerPassword = await bcrypt.hash('Seller@1234!', 12);
  for (const s of SELLERS) {
    const user = await prisma.user.upsert({
      where: { email: s.email },
      update: {},
      create: {
        email: s.email, passwordHash: sellerPassword, role: 'SELLER', emailVerified: true,
        profile: { create: { fullName: s.businessName, city: s.city, country: 'ZW' } },
      },
    });
    const profile = await prisma.sellerProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id, businessName: s.businessName, slug: slug(s.businessName), kycTier: s.tier, kycStatus: s.status,
        approvedAt: s.status === 'APPROVED' ? new Date() : null, cityId: cityIds.get(s.city), slaScore: s.sla, disputeRate: s.dispute,
        ratingAvg: s.rating[0], ratingCount: s.rating[1], leadTimeDays: s.lead, taxNumber: s.taxNumber, nationalId: s.nationalId,
      },
    });
    sellerIds.set(s.key, profile.id);
  }
  console.log(`✅ Sellers: Kuwana Retail (1P) + ${SELLERS.length} marketplace sellers`);

  // ── Products ───────────────────────────────────────────
  const productIds = new Map<string, string>();
  for (const p of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { sku: p.sku },
      update: {},
      create: {
        sku: p.sku, slug: `${slug(p.title)}-${slug(p.sku)}`, title: p.title, description: p.description,
        brandId: brandIds.get(p.brand), categoryId: categoryIds.get(p.category)!, specifications: p.specs,
        weightKg: p.weightKg, ratingAvg: p.rating?.[0] ?? 0, ratingCount: p.rating?.[1] ?? 0,
        images: { create: [{ url: placeholderImage(p.title, 800), thumbUrl: placeholderImage(p.title, 300), alt: p.title }] },
      },
    });
    productIds.set(p.sku, product.id);
    if (PRODUCT_VEHICLE[p.sku]) await prisma.product.update({ where: { id: product.id }, data: { requiredVehicleClass: PRODUCT_VEHICLE[p.sku] } });
  }

  // ── Offers ─────────────────────────────────────────────
  let created = 0;
  for (const [sku, sellerKey, fulfilment, location, price, stock, shipping = 0, listPrice] of OFFERS) {
    const productId = productIds.get(sku)!;
    const sellerId = sellerIds.get(sellerKey)!;
    const hubId = fulfilment === 'PLATFORM_FULFILLED' ? hubIds.get(location)! : null;
    const exists = await prisma.offer.findFirst({ where: { productId, sellerId, fulfilmentType: fulfilment, hubId }, select: { id: true } });
    if (exists) continue;
    await prisma.offer.create({
      data: {
        productId, sellerId, fulfilmentType: fulfilment, hubId,
        dispatchCityId: fulfilment === 'SELLER_FULFILLED' ? cityIds.get(location)! : null,
        priceUsd: price, stockQty: stock, shippingFeeUsd: shipping, listPriceUsd: listPrice,
        leadTimeDays: sellerKey === '1p' ? 1 : SELLERS.find((s) => s.key === sellerKey)!.lead,
      },
    });
    created++;
  }
  console.log(`✅ Products: ${PRODUCTS.length}, hub offers: ${created} new`);

  // ── Store branches & store stock (zero-warehouse model) ──
  const branchIds = new Map<string, string>();
  for (const b of BRANCHES) {
    const cityId = cityIds.get(b.city)!;
    const suburb = b.suburb ? await prisma.suburb.findFirst({ where: { cityId, name: b.suburb }, select: { id: true } }) : null;
    const branch = await prisma.storeBranch.upsert({
      where: { code: b.code },
      update: {},
      create: {
        code: b.code, sellerId: sellerIds.get(b.seller)!, name: b.name, cityId, suburbId: suburb?.id, address: b.address,
        landmark: b.landmark, lat: b.lat, lng: b.lng, operatingHours: b.hours as Prisma.InputJsonValue, defaultPrepTimeMins: b.prep,
      },
    });
    branchIds.set(b.code, branch.id);
  }
  // Courier-style seller offers from before branches existed are superseded by branch stock
  const retired = await prisma.offer.updateMany({ where: { fulfilmentType: 'SELLER_FULFILLED', storeBranchId: null, isActive: true }, data: { isActive: false } });
  let branchOffers = 0;
  for (const [sku, code, price, stock, listPrice] of BRANCH_OFFERS) {
    const productId = productIds.get(sku)!;
    const branch = BRANCHES.find((b) => b.code === code)!;
    const storeBranchId = branchIds.get(code)!;
    if (await prisma.offer.findFirst({ where: { productId, storeBranchId }, select: { id: true } })) continue;
    await prisma.offer.create({
      data: {
        productId, sellerId: sellerIds.get(branch.seller)!, fulfilmentType: 'SELLER_FULFILLED', storeBranchId,
        dispatchCityId: cityIds.get(branch.city)!, priceUsd: price, stockQty: stock, listPriceUsd: listPrice,
        prepTimeMins: branch.prep, leadTimeDays: 0,
      },
    });
    branchOffers++;
  }
  console.log(`✅ Stores: ${BRANCHES.length} branches, ${branchOffers} new branch offers${retired.count ? `, ${retired.count} branchless offers retired` : ''}`);

  // ── Operations staff (Phase 4) ────────────────────────
  const staffPassword = await bcrypt.hash('Staff@1234!', 12);
  const hre = hubIds.get('HRE-WKT')!;
  const avondale = await prisma.pickupPoint.findUniqueOrThrow({ where: { code: 'PP-HRE-AVD' }, select: { id: true } });
  await prisma.user.upsert({
    where: { email: 'hub.workington@example.zw' },
    update: { role: 'WAREHOUSE', hubId: hre },
    create: { email: 'hub.workington@example.zw', passwordHash: staffPassword, role: 'WAREHOUSE', hubId: hre, emailVerified: true, profile: { create: { fullName: 'Rudo (Workington hub)' } } },
  });
  await prisma.user.upsert({
    where: { email: 'agent.avondale@example.zw' },
    update: { role: 'PICKUP_AGENT', pickupPointId: avondale.id },
    create: { email: 'agent.avondale@example.zw', passwordHash: staffPassword, role: 'PICKUP_AGENT', pickupPointId: avondale.id, emailVerified: true, profile: { create: { fullName: 'Avondale counter' } } },
  });
  // Counter staff at Harare Gadget Hub, Avondale (store portal)
  const avoBranch = await prisma.storeBranch.findUnique({ where: { code: 'HGH-AVO' }, select: { id: true } });
  if (avoBranch) {
    await prisma.user.upsert({
      where: { email: 'staff.avondale@example.zw' },
      update: { role: 'STORE_STAFF', storeBranchId: avoBranch.id },
      create: { email: 'staff.avondale@example.zw', passwordHash: staffPassword, role: 'STORE_STAFF', storeBranchId: avoBranch.id, emailVerified: true, profile: { create: { fullName: 'Nyasha (Avondale counter)' } } },
    });
  }
  // An approved gig driver in Harare with a $100 float (zero-warehouse deliveries)
  const riderPassword = await bcrypt.hash('Driver@1234!', 12);
  const rider = await prisma.user.upsert({
    where: { email: 'rider.harare@example.zw' },
    update: {},
    create: { email: 'rider.harare@example.zw', phone: '+263782000111', phoneVerified: true, passwordHash: riderPassword, role: 'DRIVER', emailVerified: true, profile: { create: { fullName: 'Farai Moyo' } } },
  });
  if (!(await prisma.driverProfile.findUnique({ where: { userId: rider.id }, select: { id: true } }))) {
    const dp = await prisma.driverProfile.create({
      data: {
        userId: rider.id, nationalId: '63-1234567-F-63', licenseNumber: 'DL778812', vehicleClass: 'BIKE', vehicleReg: 'AEZ 4521', vehicleDescription: 'Red Honda CG125',
        cityId: cityIds.get('Harare'), kycStatus: 'APPROVED', approvedAt: new Date(),
        wallet: { create: { availableFloatUsd: 100 } },
      },
    });
    await prisma.driverWalletEntry.create({ data: { driverId: dp.id, type: 'FLOAT_DEPOSIT', availableDeltaUsd: 100, availableAfterUsd: 100, lockedAfterUsd: 0, earningsAfterUsd: 0, memo: 'Seed float' } });
  }
  // The food-delivery driver also drives marketplace parcels from Workington
  await prisma.user.updateMany({ where: { email: 'tafadzwa.driver@example.zw' }, data: { hubId: hre } });
  console.log('✅ Ops staff: hub.workington@example.zw, agent.avondale@example.zw, store staff staff.avondale@example.zw (Staff@1234!); gig driver rider.harare@example.zw (Driver@1234!)');

  return [...productIds.values()];
}

/** Demo zone matrix for Harare: three zones; bike and car rules (bakkies fall back to distance bands) */
const HARARE_ZONES: { code: string; name: string; suburbs: string[] }[] = [
  { code: 'ZONE_1_INNER', name: 'Zone 1 · Inner', suburbs: ['CBD', 'Avondale', 'Belvedere', 'Eastlea', 'Mbare', 'Avonlea'] },
  { code: 'ZONE_2_OUTER', name: 'Zone 2 · Outer', suburbs: ['Borrowdale', 'Mount Pleasant', 'Highlands', 'Greendale', 'Hatfield', 'Mabelreign', 'Marlborough', 'Msasa', 'Southerton', 'Waterfalls', 'Warren Park', 'Workington', 'Westgate'] },
  { code: 'ZONE_3_PERI_URBAN', name: 'Zone 3 · Peri-urban', suburbs: ['Budiriro', 'Dzivarasekwa', 'Glen View', 'Highfield', 'Kuwadzana', 'Mabvuku', 'Tafara'] },
];
/** [from, to, bike customer, bike driver, car customer, car driver] */
const HARARE_RULES: [number, number, number, number, number, number][] = [
  [0, 0, 2, 1.5, 6, 4.5], [0, 1, 3, 2.2, 8, 6], [0, 2, 4.5, 3.3, 10, 7.5],
  [1, 1, 3, 2.2, 8, 6], [1, 2, 4.5, 3.3, 10, 7.5], [2, 2, 3.5, 2.6, 9, 6.8],
];

async function seedHarareZones(prisma: PrismaClient, cityId: string) {
  if (await prisma.pricingZone.count({ where: { cityId } })) return;
  const ids: string[] = [];
  for (const [i, z] of HARARE_ZONES.entries()) {
    const zone = await prisma.pricingZone.create({ data: { cityId, code: z.code, name: z.name, sortOrder: i } });
    ids.push(zone.id);
    await prisma.suburb.updateMany({ where: { cityId, name: { in: z.suburbs } }, data: { zoneId: zone.id } });
  }
  await prisma.zonePricingRule.createMany({
    data: HARARE_RULES.flatMap(([a, b, bc, bd, cc, cd]) => [
      { originZoneId: ids[a], destinationZoneId: ids[b], vehicleClass: 'BIKE' as const, customerFeeUsd: bc, driverPayoutUsd: bd },
      { originZoneId: ids[a], destinationZoneId: ids[b], vehicleClass: 'CAR' as const, customerFeeUsd: cc, driverPayoutUsd: cd },
    ]),
  });
}
