import {
  type Context,
  type Filter,
  InlineKeyboard,
  type InlineQueryContext,
  InlineQueryResultBuilder,
} from "grammy";
import compact from "just-compact";
import { z } from "zod";
import { himawari } from "#/filters/himawari";
import type { IShikimoriService } from "#/services/shikimori";
import { zType } from "#/services/shikimori/schemas";
import type { Basic, Type, VideoKind } from "#/services/shikimori/types";
import { Callback, type CallbackData } from "#/utils/callback";
import { makeReply } from "#/utils/telegram";
import { BaseHandler } from "../base";
import { makeAnimeText } from "./anime-text";
import { makeMangaText } from "./manga-text";

export class ShikimoriSearchHandler extends BaseHandler {
  constructor(private shikimori: IShikimoriService) {
    super();

    const msg = this.comp.on("message:text");
    msg.filter(himawari("anime", "animes", "аниме"), ctx =>
      this.onSearchCommand(ctx, "animes", ctx.match),
    );
    msg.filter(himawari("manga", "mangas", "манга"), ctx =>
      this.onSearchCommand(ctx, "mangas", ctx.match),
    );

    const cbd = this.comp.on("callback_query:data");
    cbd.filter(this.titleData.has()).filter(Callback.checkId, async (ctx, next) => {
      if (ctx.data.type === "animes") return await this.onAnimeTitleData(ctx, ctx.data);
      if (ctx.data.type === "mangas") return await this.onMangaTitleData(ctx, ctx.data);
      await next();
    });
    cbd
      .filter(this.queryData.has())
      .filter(Callback.checkId, ctx => this.onChangePageData(ctx, ctx.data));

    this.comp.inlineQuery(/^anime-screenshots:(\w+)$/, ctx => this.onAnimeScreenshotsInline(ctx));
    this.comp.inlineQuery(/^anime-video:(\w+)$/, ctx => this.onAnimeVideoInline(ctx));
  }

  async onSearchCommand(ctx: Filter<Context, "message:text">, type: Type, search: string) {
    if (!search) {
      await ctx.reply("Введите название для поиска", {
        reply_parameters: makeReply(ctx.msg),
      });
      return;
    }

    const name = { animes: "аниме", mangas: "манги" }[type];

    const m = await ctx.reply(`Поиск ${name}: ${search}...`, {
      reply_parameters: makeReply(ctx.msg),
    });

    const basics = await this.shikimori.search(type, search);

    await ctx.api.editMessageText(m.chat.id, m.message_id, `Поиск ${name}: ${search}`, {
      reply_markup: this.buildBasicListMenu(basics, type, 1, ctx.from.id),
    });
  }

  async onChangePageData(
    ctx: Filter<Context, "callback_query">,
    data: CallbackData<typeof this.queryData>,
  ) {
    if (data.page < 1) {
      await ctx.answerCallbackQuery("Достигнуто начало поиска");
      return;
    }

    const text = ctx.msg?.text;
    if (!text) {
      await Promise.all([ctx.deleteMessage(), ctx.answerCallbackQuery("Что-то пошло не так")]);
      return;
    }

    const search = text.slice(text.indexOf(":") + 2);
    const basics = await this.shikimori.search(data.type, search, data.page);

    if (basics.length === 0) {
      await ctx.answerCallbackQuery("Достигнут конец поиска");
      return;
    }

    await Promise.all([
      ctx.answerCallbackQuery(),
      ctx.editMessageReplyMarkup({
        reply_markup: this.buildBasicListMenu(basics, data.type, data.page, ctx.from.id),
      }),
    ]);
  }

  async onAnimeTitleData(
    ctx: Filter<Context, "callback_query:data">,
    data: CallbackData<typeof this.titleData>,
  ) {
    const anime = await this.shikimori.anime(data.titleId);
    if (!anime) {
      await Promise.all([ctx.deleteMessage(), ctx.answerCallbackQuery("Что-то пошло не так")]);
      return;
    }

    const caption = compact([anime.russian, anime.name]).join(" | ");

    await ctx.answerCallbackQuery();
    const m = await ctx.replyWithPhoto(anime.poster.originalUrl, { caption });
    await ctx.reply(makeAnimeText(anime), {
      parse_mode: "HTML",
      reply_parameters: makeReply(m),
      link_preview_options: { is_disabled: true },
      reply_markup: InlineKeyboard.from([
        [
          InlineKeyboard.switchInlineCurrent("Скриншоты", `anime-screenshots:${anime.id}`),
          InlineKeyboard.switchInlineCurrent("Видео", `anime-video:${anime.id}`),
        ],
        [InlineKeyboard.url("Shikimori", anime.url)],
      ]),
    });
  }

  async onMangaTitleData(
    ctx: Filter<Context, "callback_query:data">,
    data: CallbackData<typeof this.titleData>,
  ) {
    const manga = await this.shikimori.manga(data.titleId);
    if (!manga) {
      await Promise.all([ctx.deleteMessage(), ctx.answerCallbackQuery("Что-то пошло не так")]);
      return;
    }

    const caption = compact([manga.russian, manga.name]).join(" | ");

    await ctx.answerCallbackQuery();
    const m = await ctx.replyWithPhoto(manga.poster.originalUrl, { caption });
    await ctx.reply(makeMangaText(manga), {
      parse_mode: "HTML",
      reply_parameters: makeReply(m),
      link_preview_options: { is_disabled: true },
      reply_markup: InlineKeyboard.from([[InlineKeyboard.url("Shikimori", manga.url)]]),
    });
  }

  async onAnimeScreenshotsInline(ctx: InlineQueryContext<Context>) {
    const titleId = ctx.match![1];

    const screenshots = await this.shikimori.screenshots(titleId);
    if (!screenshots.length) {
      await ctx.answerInlineQuery([]);
      return;
    }

    const results = screenshots.slice(0, 50).map(scr =>
      InlineQueryResultBuilder.photo(`anime-scr:${scr.id}`, scr.originalUrl, {
        photo_width: 1920,
        photo_height: 1080,
        thumbnail_url: scr.originalUrl,
      }),
    );
    await ctx.answerInlineQuery(results);
  }

  async onAnimeVideoInline(ctx: InlineQueryContext<Context>) {
    const titleId = ctx.match![1];

    const videos = await this.shikimori.videos(titleId);
    if (!videos.length) {
      await ctx.answerInlineQuery([]);
      return;
    }

    const getName = (kind: VideoKind) =>
      ({
        pv: "PV",
        cm: "CM",
        op: "Опенинг",
        ed: "Эндинг",
        clip: "Клип",
        op_ed_clip: "OP&ED клип",
        character_trailer: "Трейлер персонажа",
        episode_preview: "Превью к эпизоду",
        other: "Другое",
      })[kind];

    const results = videos.slice(0, 50).map(vid => {
      const name = vid.name ?? getName(vid.kind);
      return InlineQueryResultBuilder.videoHtml(vid.id, name, vid.playerUrl, vid.imageUrl).text(
        name + "\n" + vid.url,
      );
    });

    await ctx.answerInlineQuery(results);
  }

  buildBasicListMenu(basics: Basic[], type: Type, page: number, fromId: number) {
    const kb = new InlineKeyboard();

    for (const basic of basics) {
      let name = basic.russian ?? basic.name;
      if (basic.isCensored) name = `[18+] ${name}`;
      kb.text(name, this.titleData.make({ type, titleId: basic.id, fromId })).row();
    }

    kb.text("<< Назад", this.queryData.make({ type, page: page - 1, fromId }));
    kb.text(String(page), "nop");
    kb.text("Вперёд >>", this.queryData.make({ type, page: page + 1, fromId }));

    return kb;
  }

  private titleData = new Callback("shikiT", {
    type: zType,
    titleId: z.string(),
    fromId: z.number().int(),
  });

  private queryData = new Callback("shikiQ", {
    type: zType,
    page: z.number().int(),
    fromId: z.number().int(),
  });
}
