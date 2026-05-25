import prisma from '../../lib/prisma';
import { CreateEmergencyContactDto, UpdateEmergencyContactDto } from './emergency.schema';
import { NotFoundError } from '../../middleware/error.middleware';

export class EmergencyService {
  async list(city?: string) {
    return prisma.emergencyContact.findMany({
      where: {
        isActive: true,
        ...(city ? { city: { contains: city, mode: 'insensitive' } } : {}),
      },
      orderBy: { category: 'asc' },
    });
  }

  async create(dto: CreateEmergencyContactDto) {
    return prisma.emergencyContact.create({
      data: {
        label: dto.label,
        phone: dto.phone,
        category: dto.category,
        description: dto.description,
        city: dto.city,
        lat: dto.lat,
        lng: dto.lng,
      },
    });
  }

  async update(id: string, dto: UpdateEmergencyContactDto) {
    const contact = await prisma.emergencyContact.findUnique({ where: { id } });
    if (!contact) throw new NotFoundError('Emergency contact');
    return prisma.emergencyContact.update({ where: { id }, data: { ...dto } });
  }

  async delete(id: string) {
    const contact = await prisma.emergencyContact.findUnique({ where: { id } });
    if (!contact) throw new NotFoundError('Emergency contact');
    return prisma.emergencyContact.update({ where: { id }, data: { isActive: false } });
  }
}

export const emergencyService = new EmergencyService();
