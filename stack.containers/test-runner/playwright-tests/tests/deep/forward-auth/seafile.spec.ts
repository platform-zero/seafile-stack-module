import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  authenticatedSessionState,
  domain,
  readSeafileOnlyOfficeFixture,
  screenshotRoot,
  seafileOnlyOfficeFixturePath,
  testForwardAuthService,
  waitForGrafanaShell,
  waitForHomeAssistantShell,
} from '../shared/forward-auth';
import { serviceUrl } from '../../../utils/stack-urls';
import { logPageTelemetry, setupNetworkLogging } from '../../../utils/telemetry';

test.use({ storageState: authenticatedSessionState });

  test('Seafile - Access with forward auth', async ({ page }) => {
    test.setTimeout(180000);
    await testForwardAuthService(
      page,
      'Seafile',
      serviceUrl('seafile'),
      /Seafile|Libraries|My Libraries|Shared with me|Favorites|Shared Links|Devices|Wiki/i,
      {
        waitForSelectorVisible: 'text=/Libraries|My Libraries|Shared with me|Favorites/i',
        waitForSelectorTimeoutMs: 30000,
        onAfterLoad: async (page) => {
          const onlyOfficeFixture = readSeafileOnlyOfficeFixture();

          const dismissWelcomeModal = async () => {
            const welcomeDialog = page.locator('[role="dialog"], .modal-dialog, .ReactModal__Content').filter({
              hasText: /Welcome to Seafile/i,
            }).first();
            if (await welcomeDialog.isVisible().catch(() => false)) {
              const closeButton = welcomeDialog.locator('button[aria-label*="close" i], button.close, .sf2-icon-x1').first();
              if (await closeButton.isVisible().catch(() => false)) {
                await closeButton.click({ force: true }).catch(() => {});
              } else {
                await page.keyboard.press('Escape').catch(() => {});
              }
              await page.waitForTimeout(1000);
            }
          };

          const dismissOnlyOfficeCoachmarks = async (editorPage: import('@playwright/test').Page) => {
            const onlyOfficeTextPattern = /Switch text direction|Text direction/i;
            for (let attempt = 0; attempt < 6; attempt += 1) {
              let coachmarkVisible = false;
              for (const frame of editorPage.frames()) {
                if (!/onlyoffice|web-apps|documenteditor|presentationeditor|spreadsheeteditor/i.test(frame.url())) {
                  continue;
                }

                const coachmark = frame.locator('text=/Switch text direction|Text direction/i').first();
                if (await coachmark.isVisible().catch(() => false)) {
                  coachmarkVisible = true;
                }

                const clickTargets = ['#editor_sdk', '#viewport', '#id_main', '#id-toolbar-full', 'canvas'];
                for (const selector of clickTargets) {
                  const target = frame.locator(selector).first();
                  if (await target.isVisible().catch(() => false)) {
                    await target.click({ force: true, position: { x: 24, y: 24 } }).catch(() => {});
                    break;
                  }
                }

                await frame.evaluate((patternSource) => {
                  const pattern = new RegExp(patternSource, 'i');
                  for (const node of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
                    const text = (node.innerText || node.textContent || '').trim();
                    if (!pattern.test(text)) {
                      continue;
                    }
                    const popup = node.closest<HTMLElement>('[role="tooltip"], .tooltip, .asc-window, .asc-tooltip, .dropdown-menu');
                    const target = popup ?? node;
                    target.style.display = 'none';
                    target.setAttribute('aria-hidden', 'true');
                  }
                }, onlyOfficeTextPattern.source).catch(() => {});
              }

              await editorPage.keyboard.press('Escape').catch(() => {});
              await editorPage.waitForTimeout(500);
              if (!coachmarkVisible) {
                break;
              }
            }
          };

          const hasOnlyOfficeDownloadFailure = async (editorPage: import('@playwright/test').Page): Promise<boolean> => {
            const failurePattern = /Download failed|document could not be downloaded|unable to get local issuer certificate/i;
            const pageText = ((await editorPage.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
            if (failurePattern.test(pageText)) {
              return true;
            }
            for (const frame of editorPage.frames()) {
              const frameText = ((await frame.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
              if (failurePattern.test(frameText)) {
                return true;
              }
            }
            return false;
          };

          const uploadFixture = async (repoId: string, fileName: string, buffer: Buffer, mimeType: string) => {
            const uploadLinkResponse = await page.request.get(serviceUrl('seafile', `/api2/repos/${repoId}/upload-link/?p=/`));
            expect(uploadLinkResponse.ok()).toBeTruthy();
            const uploadLinkRaw = (await uploadLinkResponse.text()).trim().replace(/^"|"$/g, '');
            const uploadTarget = new URL(uploadLinkRaw, serviceUrl('seafile')).toString();
            const uploadResponse = await page.request.post(uploadTarget, {
              multipart: {
                parent_dir: '/',
                replace: '1',
                file: {
                  name: fileName,
                  mimeType,
                  buffer,
                },
              },
            });
            expect(uploadResponse.ok()).toBeTruthy();
          };

          const preferredLibraryName = 'Playwright Demo Library';
          const docName = 'seafile-onlyoffice-demo.docx';
          const notesName = 'stack-demo-notes.txt';

          const reposResponse = await page.request.get(serviceUrl('seafile', '/api2/repos/'));
          expect(reposResponse.ok()).toBeTruthy();
          const repos = await reposResponse.json();
          let repo = repos.find((entry: any) => entry.name === preferredLibraryName) ?? repos[0];

          if (!repo) {
            const createRepoResponse = await page.request.post(serviceUrl('seafile', '/api2/repos/'), {
              form: {
                name: preferredLibraryName,
                desc: 'Playwright validation library for Seafile and OnlyOffice screenshots',
              },
              headers: {
                Referer: serviceUrl('seafile'),
              },
            });
            if (createRepoResponse.ok()) {
              repo = await createRepoResponse.json();
            } else {
              const createBody = await createRepoResponse.text().catch(() => '');
              console.log(
                `   ⚠️  Seafile library creation failed (${createRepoResponse.status()}); falling back to the first available repo. ${createBody.slice(0, 200)}`
              );
              repo = repos[0];
            }
          }

          const repoId = repo.repo_id || repo.id;
          if (!repoId) {
            throw new Error(`Could not determine Seafile repo id from ${JSON.stringify(repo)}`);
          }
          const libraryName = repo.name || preferredLibraryName;

          await uploadFixture(
            repoId,
            docName,
            onlyOfficeFixture,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          );
          await uploadFixture(
            repoId,
            notesName,
            Buffer.from('Stack demo notes\n\n- Bazel deploy path validated\n- Seafile UI shows uploaded fixtures\n', 'utf-8'),
            'text/plain'
          );

          await page.goto(serviceUrl('seafile', `/library/${repoId}/${encodeURIComponent(libraryName)}/`), {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
          await dismissWelcomeModal();
          await expect(page.getByText(new RegExp(docName, 'i')).first()).toBeVisible({ timeout: 30000 });
          await expect(page.getByText(new RegExp(notesName, 'i')).first()).toBeVisible({ timeout: 30000 });

          const docLink = page.getByRole('link', { name: new RegExp(docName, 'i') }).first();
          const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
          await docLink.dblclick({ force: true }).catch(async () => {
            await docLink.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
            await docLink.click({ force: true }).catch(() => {});
          });

          const popup = await popupPromise;
          const docPage = popup ?? page;
          await docPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
          await docPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
          await expect
            .poll(
              async () => {
                const frameUrls = docPage.frames().map((frame) => frame.url()).join('\n');
                const bodyText = (await docPage.textContent('body').catch(() => '')) || '';
                return `${frameUrls}\n${bodyText}`;
              },
              { timeout: 90000, intervals: [1000, 2000, 3000] }
            )
            .toMatch(/onlyoffice|document editor|web-apps|presentation editor|spreadsheet editor|text document/i);
          await docPage.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
          await expect
            .poll(
              async () => {
                for (const frame of docPage.frames()) {
                  if (!/onlyoffice|web-apps|documenteditor|presentationeditor|spreadsheeteditor/i.test(frame.url())) {
                    continue;
                  }

                  const editorSelectors = [
                    '#toolbar',
                    '#viewport',
                    '#editor_sdk',
                    '#id_main',
                    '#id-toolbar-full',
                    'canvas',
                  ];
                  for (const selector of editorSelectors) {
                    if (await frame.locator(selector).first().isVisible().catch(() => false)) {
                      return true;
                    }
                  }

                  const frameText = (await frame.textContent('body').catch(() => '')) || '';
                  if (/document editor|text document|presentation editor|spreadsheet editor/i.test(frameText)) {
                    return true;
                  }
                }

                const editorFrame = docPage.locator('iframe[src*="onlyoffice"], iframe[src*="web-apps"], iframe[name*="frameEditor" i]').first();
                return editorFrame.isVisible().catch(() => false);
              },
              { timeout: 90000, intervals: [1000, 2000, 3000] }
            )
            .toBeTruthy();
          await expect
            .poll(
              async () => {
                const pageLoadingTextVisible = await docPage
                  .locator('text=/Loading document/i')
                  .first()
                  .isVisible()
                  .catch(() => false);
                if (pageLoadingTextVisible) {
                  return false;
                }

                for (const frame of docPage.frames()) {
                  const frameLoadingTextVisible = await frame
                    .locator('text=/Loading document/i')
                    .first()
                    .isVisible()
                    .catch(() => false);
                  if (frameLoadingTextVisible) {
                    return false;
                  }

                  const frameBodyText = ((await frame.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
                  if (/loading document/i.test(frameBodyText)) {
                    return false;
                  }
                }

                const bodyText = ((await docPage.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
                return !/loading document/i.test(bodyText);
              },
              { timeout: 90000, intervals: [1000, 2000, 3000] }
            )
            .toBeTruthy();
          await expect
            .poll(
              async () => !(await hasOnlyOfficeDownloadFailure(docPage)),
              { timeout: 10000, intervals: [1000, 2000] }
            )
            .toBeTruthy();
          await docPage.waitForTimeout(5000);

          if (await hasOnlyOfficeDownloadFailure(docPage)) {
            throw new Error('OnlyOffice editor reported a document download failure.');
          }

          await dismissOnlyOfficeCoachmarks(docPage);
          await docPage.screenshot({
            path: path.join(screenshotRoot, 'seafile-onlyoffice-document.jpeg'),
            type: 'jpeg',
            quality: 88,
            fullPage: true,
          });

          if (popup) {
            await popup.close().catch(() => {});
            await page.bringToFront().catch(() => {});
          } else {
            await page.goto(serviceUrl('seafile', `/library/${repoId}/${encodeURIComponent(libraryName)}/`), {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
            await dismissWelcomeModal();
          }

          await expect(page.getByText(new RegExp(docName, 'i')).first()).toBeVisible({ timeout: 30000 });
          await expect(page.getByText(new RegExp(notesName, 'i')).first()).toBeVisible({ timeout: 30000 });
        },
      }
    );
  });
