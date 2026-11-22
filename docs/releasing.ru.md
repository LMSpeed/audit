# Публикация lmspeed-audit

[English](./releasing.md) · [简体中文](./releasing.zh-CN.md) · [Русский](./releasing.ru.md)

Стабильные теги `vX.Y.Z` запускают `.github/workflows/release.yml`. Тег должен совпадать с `package.json` и `ENGINE_VERSION`. Процесс проверяет пакет, устанавливает tarball в чистом проекте и тестирует переносимую команду на Linux, macOS и Windows с Node.js 22 и 24 до публикации загрузок. Релизы неизменяемы; повторные запуски используют исходные файлы.

Если начальный токен не настроен, задача npm проверяет OIDC-обмен GitHub → npm даже при существующей версии. Это подтверждает работоспособность trusted publisher без создания новой публичной версии. Полученные учётные данные не выводятся и не сохраняются.

## Реестры

- npm: [`@lmspeed/audit`](https://www.npmjs.com/package/@lmspeed/audit), публичный пакет с подтверждением происхождения. Для первой публикации настройте secret репозитория `NPM_TOKEN` с правом публикации пакета в scope `@lmspeed`. После создания пакета настройте [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/): организация `LMSpeed`, репозиторий `audit`, workflow `release.yml`, без environment. После проверки удалите secret токена; workflow имеет `id-token: write` для OIDC. `pnpm publish` использует npm CLI из Node.js 24; необходим npm >=11.5.1.
- GitHub Packages: [`@lmspeed/audit`](https://github.com/lmspeed/audit/pkgs/npm/audit), с `GITHUB_TOKEN` этого репозитория. Scope должен совпадать с владельцем репозитория. В обоих реестрах имя пакета одинаково; направляйте scope `@lmspeed` на GitHub Packages только при использовании этого реестра. GitHub создаёт пакет приватным: после первой публикации установите в настройках **Public**. Даже установка публичных npm-пакетов GitHub требует токена `read:packages`. См. [документацию реестра GitHub](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

## Homebrew, Scoop и загрузки

Репозиторий служит также Homebrew tap (`Formula/`) и Scoop bucket (`bucket/`). После релиза workflow коммитит точные сгенерированные манифесты в `main`. Они ссылаются на версионные архивы релиза с SHA-256. Переносимые архивы содержат зависимости и все лицензионные уведомления; требуют Node.js >=22.12 и не загружают код при установке. Homebrew устанавливает Node.js автоматически; Scoop зависит от `nodejs-lts`. Эти tap и bucket сопровождает сам проект; включение в Homebrew/core, Scoop main, winget или Chocolatey не заявляется.

```sh
pnpm check
pnpm release:prepare
pnpm release:smoke
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Перед созданием тега обновите английскую, китайскую и русскую истории изменений. Для повтора публикации в реестрах или обновления установщиков запустите `release.yml` вручную с существующим тегом; опубликованные версии пропускаются. Не заменяйте существующие файлы релиза или тег. Исправление упаковки после публикации требует новой версии пакета и движка и нового тега.

Домашняя страница пакета, метаданные реестров, установщики и README ведут к [онлайн-аудиту LMSpeed](https://lmspeed.net/ru/audit). Раздел методологии LMSpeed содержит ссылки на репозиторий и каналы установки.

## Перенос репозитория

Начиная с 0.3.3 основной репозиторий — [lmspeed/audit](https://github.com/lmspeed/audit). Существующие релизы и их файлы остаются неизменными; GitHub перенаправляет прежние URL. Версии GitHub Packages до 0.3.3 сохраняются под прежним именем `@nexmoe/lmspeed-audit`. Новые версии в обоих реестрах используют `@lmspeed/audit`.

Пользователи Homebrew могут выполнить `brew uninstall lmspeed-audit`, затем `brew untap nexmoe/lmspeed-audit` и новые команды tap/установки из README. Пользователи Scoop могут удалить и снова добавить bucket `lmspeed` с новым URL репозитория; установленные приложения сохранятся.
