// Created by dev on 2026/05/21
import { getLogger } from '@memforgeai/shared';
import type { ImportTicketsInput } from '@memforgeai/shared';
import type { KnowledgePostgresStorage } from '../storage/postgres.js';

const logger = getLogger('knowledge:ticket-import');

export class TicketImporter {
  constructor(private readonly storage: KnowledgePostgresStorage) {}

  async importTickets(input: ImportTicketsInput, userId: string | null): Promise<{ accepted: number; duplicates: number }> {
    let accepted = 0;
    let duplicates = 0;

    for (const ticket of input.tickets) {
      if (ticket.ticketId) {
        const existing = await this.storage.findBySourceRef('ticket', ticket.ticketId);
        if (existing) {
          duplicates++;
          continue;
        }
      }

      const mediaText = (ticket.media ?? [])
        .filter(m => m.type === 'image')
        .map(() => '')
        .join(' ');

      await this.storage.store({
        projectId: input.productLine,
        productLine: input.productLine,
        knowledgeType: 'faq',
        category: ticket.category,
        title: ticket.title,
        question: ticket.description,
        content: ticket.resolution,
        tags: ticket.tags,
        answerType: 'direct',
        embedding: null,
        mediaText,
        media: (ticket.media ?? []).map(m => ({
          type: m.type,
          url: m.url,
        })),
        sourceType: 'ticket',
        sourceRef: ticket.ticketId,
        visibility: 'product_line',
        createdBy: userId,
      });
      accepted++;
    }

    logger.info({ accepted, duplicates, productLine: input.productLine }, 'Ticket import completed');
    return { accepted, duplicates };
  }
}
