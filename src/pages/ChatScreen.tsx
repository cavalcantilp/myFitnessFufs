import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '../state/AppContext'
import { AnthropicError, askAssistant, type AnthropicTool } from '../lib/anthropic'
import { MONTHLY_CAP_USD } from '../lib/usage'
import { extractMealSuggestions, mealFullyResolved } from '../lib/mealSuggestions'
import { foodName, statesOf } from '../lib/foods'
import { sumNutrients } from '../lib/nutrition'
import { formatDay, shiftDay, todayKey } from '../lib/date'
import { defaultMeal, guessMealFromLabel, mealLabel } from '../lib/meals'
import { IconCalendar, IconCheck, IconChevronLeft, IconClose, IconPlus, IconSend, IconTrash } from '../components/icons'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { CustomFoodSheet } from '../components/CustomFoodSheet'
import { SchedulePicker } from '../components/SchedulePicker'
import type { TranslationKey } from '../i18n/translations'
import type {
  ChatMealNewFoodItem,
  ChatMealSuggestion,
  ChatMessage,
  DiaryEntry,
  FoodState,
  FridgeLocation,
  Lang,
  MealDef,
  MealId,
  MeasurementEntry,
  WeightEntry,
} from '../lib/types'

interface ChatScreenProps {
  onClose: () => void
  onOpenProfile: () => void
  onToast: (message: string) => void
}

interface StockIndexItem {
  id: string
  label: string
  grams?: number
  location: FridgeLocation
}

/**
 * Outil que le modèle peut appeler pour lire le passé (repas, poids,
 * mensurations) sans que cet historique soit envoyé à chaque message —
 * seul aujourd'hui l'est systématiquement, pour limiter le coût.
 */
const HISTORY_TOOL: AnthropicTool = {
  name: 'get_history',
  description:
    "Renvoie le détail des repas loggés, le poids et les mensurations enregistrés pour les N derniers jours " +
    "(hier inclus, en remontant). N'appelle cet outil que si la question porte sur le passé (hier, cette " +
    "semaine, une tendance de poids...) — les données d'aujourd'hui sont déjà fournies plus haut.",
  input_schema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        description: "Nombre de jours en arrière à couvrir, en partant d'hier (1 à 30).",
      },
    },
    required: ['days'],
  },
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Le modèle écrit parfois en markdown (**gras**) — jamais montré tel quel avec ses astérisques,
 * ni transformé en gras : mis en évidence par la couleur, seule façon de faire ressortir une
 * donnée dans une bulle de conversation.
 */
function renderHighlighted(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const regex = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    parts.push(
      <span className="chat-highlight" key={key++}>
        {match[1]}
      </span>,
    )
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}

const SUGGESTIONS = ['chat.suggest.plan', 'chat.suggest.remaining', 'chat.suggest.quick'] as const

const LOCATION_LABEL: Record<FridgeLocation, string> = { fridge: 'Frigo', pantry: 'Placard', freezer: 'Congélateur' }
const LOCATION_ORDER: FridgeLocation[] = ['fridge', 'pantry', 'freezer']

/**
 * Construit le contexte invisible envoyé à chaque appel : ce qu'il y a au
 * frigo/placard/congélateur et ce qu'il reste à manger aujourd'hui. Sans lui,
 * l'utilisateur devrait retaper cette information à chaque message.
 */
function buildSystemPrompt(
  lang: Lang,
  stock: StockIndexItem[],
  remaining: { kcal: number; protein: number; carbs: number; fat: number },
  todayLines: string[],
): string {
  const todayBlock = todayLines.length > 0 ? todayLines.map((line) => `- ${line}`).join('\n') : '(rien loggé pour le moment)'
  const stockBlock = LOCATION_ORDER.map((location) => {
    const items = stock.filter((item) => item.location === location)
    const lines =
      items.length > 0
        ? items
            .map(
              (item) =>
                `  - id="${item.id}" | ${item.label}${item.grams !== undefined ? ` | ${item.grams} g disponibles` : ' | quantité non précisée'}`,
            )
            .join('\n')
        : '  (vide)'
    return `${LOCATION_LABEL[location]} :\n${lines}`
  }).join('\n')

  return [
    "Tu es l'assistant nutrition intégré à l'application FitnessFufs. Réponds dans la langue du dernier " +
      'message de l\'utilisateur.',
    '',
    'Sois bref, systématiquement : va droit à la proposition concrète, sans salutation, sans reformuler ' +
      "la question, sans conclusion ni rappel des macros déjà donnés plus haut. Deux ou trois phrases " +
      'courtes suffisent la plupart du temps ; une liste à puces brève si plusieurs idées sont utiles. ' +
      "Jamais de longs paragraphes explicatifs, jamais d'options multiples détaillées sauf si demandé.",
    '',
    'Aliments actuellement disponibles, par emplacement (avec identifiant technique interne, à ne jamais ' +
      'citer dans ta réponse visible). Le congélateur suppose une décongélation avant cuisson, le placard ' +
      "des produits secs ou en conserve — tiens-en compte dans ce que tu proposes :",
    stockBlock,
    '',
    "Repas déjà loggés aujourd'hui :",
    todayBlock,
    '',
    "Macros restants pour aujourd'hui (objectif du jour moins ce qui a déjà été mangé) :",
    `- Calories : ${remaining.kcal} kcal`,
    `- Protéines : ${remaining.protein} g`,
    `- Glucides : ${remaining.carbs} g`,
    `- Lipides : ${remaining.fat} g`,
    '',
    "Pour toute question portant sur le passé (hier, cette semaine, l'évolution du poids...), utilise " +
      "l'outil get_history plutôt que de répondre au hasard ou de dire que tu n'as pas accès à ces " +
      'données — tu y as accès via cet outil.',
    '',
    'Propose des idées de repas réalistes avec ce qui est disponible (frigo, placard, congélateur), en ' +
      'tenant compte de ces macros restants. Indique les quantités à utiliser parmi ce qui est ' +
      "disponible ; pour un aliment sans quantité précisée, suppose une quantité raisonnable. Tu peux " +
      'suggérer un ingrédient simple à ajouter si peu de choses manquent. (Langue de référence de ' +
      "l'application : " +
      lang +
      '.)',
    '',
    "Chaque repas proposé doit être un plat cohérent, pas une simple combinaison d'aliments du stock " +
      "choisis uniquement pour coller aux macros restants. Avant de proposer, demande-toi si ce plat " +
      "existe vraiment en cuisine — s'il fallait le nommer, le nom aurait-il un sens (« poulet-riz-brocolis " +
      "sauté », « yaourt et fruits », « omelette aux légumes »...) ? Si deux aliments disponibles ne se " +
      "marient pas naturellement (ex. un fromage frais et un légume vapeur sans lien), ne les combine pas " +
      "dans le même repas sous prétexte qu'ils complètent les macros — propose plutôt deux repas séparés, " +
      "ou accepte de ne pas tout utiliser.",
    '',
    "Si ta réponse propose un ou plusieurs repas concrets, ajoute tout à la fin, sur une seule ligne, ce " +
      "bloc caché (jamais montré tel quel, jamais mentionné dans ta réponse) : " +
      '<meals>[{"label":"court résumé du repas","items":[...]}]</meals>. Chaque item est soit ' +
      '{"foodId":"identifiant exact listé ci-dessus","grams":nombre,"state":"raw ou cooked, uniquement si ' +
      'applicable"} pour un aliment déjà disponible, soit {"name":"nom de l\'ingrédient à ajouter",' +
      '"grams":nombre,"kcal":nombre,"protein":nombre,"carbs":nombre,"fat":nombre} pour un ingrédient simple ' +
      "qui manque — kcal/protein/carbs/fat étant ton estimation pour 100 g (l'application vérifie d'abord " +
      "si cet aliment existe déjà dans son catalogue avant de proposer de le créer, donc n'hésite pas à " +
      "nommer des ingrédients courants même si tu ne sais pas s'ils sont déjà disponibles). Un objet par " +
      "repas proposé, avec un grams réaliste même pour un aliment sans quantité précisée. N'utilise jamais " +
      "un foodId qui n'est pas listé ci-dessus. Si aucun repas concret n'est proposé dans cette réponse, " +
      'ajoute quand même <meals>[]</meals>. Ce bloc doit toujours être la toute dernière chose de ta ' +
      'réponse, rien après lui.',
    '',
    "Important : tu ne peux jamais écrire toi-même dans le journal, mais l'application le fait à ta place " +
      "dès qu'un repas figure dans ce bloc — un bouton apparaît alors pour que l'utilisateur confirme " +
      "l'ajout d'un clic. Ne dis donc jamais que tu n'as pas accès à cette fonction et ne demande jamais à " +
      "l'utilisateur de tout ressaisir lui-même dans l'application. Si l'utilisateur demande d'ajouter au " +
      "journal un ou plusieurs repas déjà décrits plus haut dans la conversation, republie-les simplement " +
      "dans le bloc <meals> de cette réponse (même sans nouvelle suggestion), en reprenant les mêmes " +
      "aliments et quantités.",
    '',
    "Les valeurs nutritionnelles que tu donnes de mémoire (hors aliments listés ci-dessus, dont les " +
      "chiffres viennent du catalogue de l'application et sont fiables) restent des estimations, parfois " +
      "fausses — n'affiche jamais une précision que tu n'as pas. Si l'utilisateur corrige une valeur, " +
      "utilise sa correction pour le reste de cette conversation, mais ne prétends jamais que tu vas t'en " +
      "souvenir « la prochaine fois » ou dans une future conversation : tu ne conserves aucune mémoire " +
      "au-delà de cet échange.",
  ].join('\n')
}

/** Construit le texte renvoyé à l'outil get_history — bornée à 30 jours, jamais illimité. */
function formatHistory(
  input: Record<string, unknown>,
  context: {
    entries: DiaryEntry[]
    weights: WeightEntry[]
    measurements: MeasurementEntry[]
    mealDefs: MealDef[]
    t: (key: TranslationKey, vars?: Record<string, string | number>) => string
    lang: Lang
  },
): string {
  const days = Math.min(30, Math.max(1, Math.round(Number(input.days) || 7)))
  const today = todayKey()
  const lines: string[] = []
  const labelForMeal = (mealId: string) => {
    const meal = context.mealDefs.find((entry) => entry.id === mealId)
    return meal ? mealLabel(meal, context.t) : mealId
  }

  for (let i = 1; i <= days; i++) {
    const date = shiftDay(today, -i)
    const dayEntries = context.entries.filter((entry) => entry.date === date)
    const weight = context.weights.find((entry) => entry.date === date)
    const measurement = context.measurements.find((entry) => entry.date === date)
    if (dayEntries.length === 0 && !weight && !measurement) continue

    const parts = [date]
    if (dayEntries.length > 0) {
      const totals = sumNutrients(dayEntries.map((entry) => entry.nutrients))
      const items = dayEntries.map((entry) => `${entry.label} ${entry.grams} g [${labelForMeal(entry.meal)}]`).join(', ')
      parts.push(
        `repas: ${items} — total ${Math.round(totals.kcal)} kcal, ${Math.round(totals.protein)} g prot, ` +
          `${Math.round(totals.carbs)} g gluc, ${Math.round(totals.fat)} g lip`,
      )
    }
    if (weight) parts.push(`poids: ${weight.weight} kg`)
    if (measurement) {
      const values = Object.entries(measurement.values)
        .map(([key, value]) => `${key} ${value} cm`)
        .join(', ')
      if (values) parts.push(`mensurations: ${values}`)
    }
    lines.push(parts.join(' | '))
  }

  return lines.length > 0 ? lines.join('\n') : 'Aucune donnée sur cette période.'
}

export function ChatScreen({ onClose, onOpenProfile, onToast }: ChatScreenProps) {
  const {
    t,
    lang,
    foods,
    fridge,
    targetsFor,
    entriesFor,
    entries,
    weights,
    measurements,
    mealDefs,
    addEntry,
    apiKey,
    chatMessages,
    addChatMessage,
    updateChatMessage,
    clearChat,
    usage,
    addUsageCost,
  } = useApp()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Réinitialisé à chaque ouverture (ChatScreen est remonté à chaque fois) :
  // les suggestions reviennent à chaque visite, et disparaissent dès qu'on
  // envoie un message dans cette visite, historique ou pas.
  const [interacted, setInteracted] = useState(false)
  // Repas déjà envoyés au journal, identifiés par "id du message-index du repas" —
  // sert uniquement à désactiver le bouton une fois cliqué, pas persisté.
  const [sentMeals, setSentMeals] = useState<Record<string, boolean>>({})
  // Ingrédients créés depuis une suggestion et déjà ajoutés au journal — sert
  // uniquement à désactiver la puce "Créer", pas persisté.
  const [createdFoods, setCreatedFoods] = useState<Record<string, boolean>>({})
  const [confirmingClear, setConfirmingClear] = useState(false)
  // Écran de création d'aliment ouvert depuis une suggestion, pré-rempli avec
  // l'estimation du modèle — remplace tout l'écran, comme dans l'onglet Ajouter.
  const [creatingFood, setCreatingFood] = useState<{
    messageId: string
    mealIndex: number
    itemIndex: number
    item: ChatMealNewFoodItem
  } | null>(null)
  // Choix d'une date pour planifier un repas résolu — un écran par-dessus,
  // comme la création d'aliment, sans remplacer le chat en dessous (son défilement doit survivre au retour).
  const [schedulingMeal, setSchedulingMeal] = useState<{
    messageId: string
    mealIndex: number
    items: ChatMealSuggestion['items']
    // Deviné depuis le résumé du repas ("Petit-déj", "Collation"...) — l'heure de la
    // conversation n'a aucun rapport avec le jour visé, donc pas de defaultMeal() ici.
    initialMeal: MealId | undefined
  } | null>(null)
  // Repas déjà planifiés, avec la date et le repas choisis — le bouton « Planifier »
  // laisse alors place à une confirmation, comme pour l'envoi immédiat.
  const [scheduledMeals, setScheduledMeals] = useState<Record<string, { date: string; meal: MealId }>>({})
  const listRef = useRef<HTMLDivElement>(null)

  // Estimation seulement — pas une vraie limite de facturation Anthropic —
  // mais suffisante pour éviter les mauvaises surprises côté personnel.
  const capped = usage.costUsd >= MONTHLY_CAP_USD

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chatMessages, sending])

  const stateLabel = (state: FoodState | undefined) =>
    state ? ` (${t(state === 'raw' ? 'state.raw' : 'state.cooked').toLowerCase()})` : ''

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sending || !apiKey || capped) return
    setInput('')
    setError(null)
    setInteracted(true)
    const userMessage: ChatMessage = { id: newId(), role: 'user', text: trimmed, at: new Date().toISOString() }
    addChatMessage(userMessage)
    setSending(true)
    try {
      const today = todayKey()
      const targets = targetsFor(today)
      const eaten = sumNutrients(entriesFor(today).map((entry) => entry.nutrients))
      const remaining = {
        kcal: Math.round(targets.kcal - eaten.kcal),
        protein: Math.round(targets.protein - eaten.protein),
        carbs: Math.round(targets.carbs - eaten.carbs),
        fat: Math.round(targets.fat - eaten.fat),
      }
      const stockIndex: StockIndexItem[] = fridge
        .map((item): StockIndexItem | null => {
          const food = foods.find((entry) => entry.id === item.foodId)
          if (!food) return null
          return {
            id: item.foodId,
            label: `${foodName(food, lang)}${stateLabel(item.state)}`,
            grams: item.grams,
            location: item.location ?? 'fridge',
          }
        })
        .filter((entry): entry is StockIndexItem => entry !== null)
      const todayLines = entriesFor(today).map((entry) => {
        const meal = mealDefs.find((defEntry) => defEntry.id === entry.meal)
        const label = meal ? mealLabel(meal, t) : entry.meal
        return `[${label}] ${entry.label}${stateLabel(entry.state)} — ${entry.grams} g`
      })
      const system = buildSystemPrompt(lang, stockIndex, remaining, todayLines)
      const reply = await askAssistant(
        apiKey,
        [...chatMessages, userMessage],
        system,
        [HISTORY_TOOL],
        (name, toolInput) =>
          name === 'get_history' ? formatHistory(toolInput, { entries, weights, measurements, mealDefs, t, lang }) : 'Outil inconnu.',
      )
      const { text, meals } = extractMealSuggestions(reply.text, foods, lang)
      addChatMessage({
        id: newId(),
        role: 'assistant',
        text,
        at: new Date().toISOString(),
        meals: meals.length > 0 ? meals : undefined,
      })
      addUsageCost(reply.costUsd)
    } catch (err) {
      setError(err instanceof AnthropicError ? err.message : t('chat.error'))
    } finally {
      setSending(false)
    }
  }

  const addMealToDiary = (date: string, items: ChatMealSuggestion['items'], meal: MealId) => {
    for (const item of items) {
      if (item.kind !== 'food') continue
      const food = foods.find((entry) => entry.id === item.foodId)
      if (!food) continue
      addEntry(date, meal, food, item.grams, item.state)
    }
  }

  const sendMealToDiary = (messageId: string, mealIndex: number, suggestion: ChatMealSuggestion) => {
    const meal = guessMealFromLabel(suggestion.label, mealDefs, lang) ?? defaultMeal()
    addMealToDiary(todayKey(), suggestion.items, meal)
    setSentMeals((current) => ({ ...current, [`${messageId}-${mealIndex}`]: true }))
    onToast(t('chat.mealAdded'))
  }

  /** Choisir un candidat résout l'ingrédient en place, sans toucher au journal — l'ajout reste au bouton du repas. */
  const pickCandidate = (messageId: string, mealIndex: number, itemIndex: number, foodId: string, state: FoodState | undefined) => {
    const message = chatMessages.find((entry) => entry.id === messageId)
    if (!message?.meals) return
    const meals = message.meals.map((meal, mIdx) => {
      if (mIdx !== mealIndex) return meal
      return {
        ...meal,
        items: meal.items.map((item, iIdx) => {
          if (iIdx !== itemIndex || item.kind !== 'suggested') return item
          return { kind: 'food' as const, foodId, grams: item.grams, state }
        }),
      }
    })
    updateChatMessage(messageId, { meals })
  }

  /** Un ingrédient qu'on ne veut pas garder — le repas disparaît avec lui si c'était le dernier. */
  const removeMealItem = (messageId: string, mealIndex: number, itemIndex: number) => {
    const message = chatMessages.find((entry) => entry.id === messageId)
    if (!message?.meals) return
    const meals = message.meals
      .map((meal, mIdx) => (mIdx !== mealIndex ? meal : { ...meal, items: meal.items.filter((_, iIdx) => iIdx !== itemIndex) }))
      .filter((meal) => meal.items.length > 0)
    updateChatMessage(messageId, { meals: meals.length > 0 ? meals : undefined })
  }

  return (
    <div className="chat-screen">
      <div className="chat-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <IconChevronLeft />
        </button>
        <div className="chat-head-title">
          <h2>{t('chat.title')}</h2>
        </div>
        {chatMessages.length > 0 ? (
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => setConfirmingClear(true)}
            aria-label={t('chat.clear')}
          >
            <IconTrash size={18} />
          </button>
        ) : null}
      </div>

      <div className="chat-messages" ref={listRef}>
        {chatMessages.length === 0 ? <p className="hint">{t('chat.empty')}</p> : null}
        {chatMessages.map((message) => (
          <div key={message.id} className="chat-message-group">
            <div className={`chat-bubble ${message.role}`}>{renderHighlighted(message.text)}</div>
            {message.meals && message.meals.length > 0 ? (
              <div className="meal-actions">
                {message.meals.map((suggestion, mealIndex) => {
                  const sent = sentMeals[`${message.id}-${mealIndex}`]
                  const scheduled = scheduledMeals[`${message.id}-${mealIndex}`]
                  const scheduledMealDef = scheduled ? mealDefs.find((entry) => entry.id === scheduled.meal) : undefined
                  const removeBtn = (itemIndex: number) => (
                    <button
                      type="button"
                      className="meal-item-remove"
                      aria-label={t('chat.removeIngredient')}
                      onClick={() => removeMealItem(message.id, mealIndex, itemIndex)}
                    >
                      <IconClose size={14} />
                    </button>
                  )

                  return (
                    <div className="meal-actions-group" key={mealIndex}>
                      {suggestion.items.map((item, itemIndex) => {
                        if (item.kind === 'food') {
                          const food = foods.find((entry) => entry.id === item.foodId)
                          if (!food) return null
                          return (
                            <div className="meal-item" key={itemIndex}>
                              <span>
                                {foodName(food, lang)}
                                {stateLabel(item.state)} — {item.grams} g
                              </span>
                              {removeBtn(itemIndex)}
                            </div>
                          )
                        }

                        if (item.kind === 'newFood') {
                          const key = `${message.id}-${mealIndex}-${itemIndex}`
                          const created = createdFoods[key]
                          return (
                            <div className="meal-item" key={itemIndex}>
                              <button
                                type="button"
                                className="meal-btn create"
                                disabled={created}
                                onClick={() => setCreatingFood({ messageId: message.id, mealIndex, itemIndex, item })}
                              >
                                <span>{item.name}</span>
                                {created ? (
                                  <IconCheck size={16} />
                                ) : (
                                  <span className="meal-btn-cta">
                                    <IconPlus size={14} /> {t('chat.createFood')}
                                  </span>
                                )}
                              </button>
                              {!created ? removeBtn(itemIndex) : null}
                            </div>
                          )
                        }

                        if (item.kind === 'suggested') {
                          const key = `${message.id}-${mealIndex}-${itemIndex}`
                          if (createdFoods[key]) {
                            return (
                              <div className="meal-item" key={itemIndex}>
                                <div className="meal-btn create">
                                  <span>{item.name}</span>
                                  <IconCheck size={16} />
                                </div>
                              </div>
                            )
                          }
                          return (
                            <div className="meal-item" key={itemIndex}>
                              <div className="meal-suggest">
                                <span className="meal-suggest-label">{t('chat.similarFound', { name: item.name })}</span>
                                <div className="meal-suggest-row">
                                  {item.candidateIds.flatMap((foodId) => {
                                    const food = foods.find((entry) => entry.id === foodId)
                                    if (!food) return []
                                    // Un aliment cru et cuit ont des macros très différentes : les deux
                                    // états se proposent séparément plutôt qu'un choix par défaut au hasard.
                                    const states = statesOf(food)
                                    const options = states.length > 0 ? states : [undefined]
                                    return options.map((state) => (
                                      <button
                                        type="button"
                                        className="chip"
                                        key={`${foodId}-${state ?? 'default'}`}
                                        onClick={() => pickCandidate(message.id, mealIndex, itemIndex, foodId, state)}
                                      >
                                        {foodName(food, lang)}
                                        {stateLabel(state)}
                                      </button>
                                    ))
                                  })}
                                  <button
                                    type="button"
                                    className="chip"
                                    onClick={() =>
                                      setCreatingFood({
                                        messageId: message.id,
                                        mealIndex,
                                        itemIndex,
                                        item: { kind: 'newFood', name: item.name, grams: item.grams, ...item.newFood },
                                      })
                                    }
                                  >
                                    {t('chat.createInstead')}
                                  </button>
                                </div>
                              </div>
                              {removeBtn(itemIndex)}
                            </div>
                          )
                        }

                        return null
                      })}
                      {mealFullyResolved(suggestion) ? (
                        <div className="meal-btn-row">
                          <button
                            type="button"
                            className="meal-btn"
                            disabled={sent}
                            onClick={() => sendMealToDiary(message.id, mealIndex, suggestion)}
                          >
                            <span>{suggestion.label}</span>
                            {sent ? <IconCheck size={16} /> : <span className="meal-btn-cta">{t('chat.sendToDiary')}</span>}
                          </button>
                          {!scheduled ? (
                            <button
                              type="button"
                              className="meal-btn schedule"
                              onClick={() =>
                                setSchedulingMeal({
                                  messageId: message.id,
                                  mealIndex,
                                  items: suggestion.items,
                                  initialMeal: guessMealFromLabel(suggestion.label, mealDefs, lang),
                                })
                              }
                            >
                              <span className="meal-btn-cta">
                                <IconCalendar size={14} /> {t('chat.schedule')}
                              </span>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {scheduled ? (
                        <div className="meal-scheduled-note">
                          <IconCheck size={14} />
                          <span>
                            {t('chat.mealScheduledLabel', {
                              meal: scheduledMealDef ? mealLabel(scheduledMealDef, t) : scheduled.meal,
                              date: formatDay(scheduled.date, lang),
                            })}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        ))}
        {sending ? (
          <div className="chat-bubble assistant pending" role="status" aria-label={t('chat.thinking')}>
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : null}
      </div>

      {error ? <p className="notice chat-error">{error}</p> : null}

      {!interacted && !capped ? (
        <div className="chip-list">
          {SUGGESTIONS.map((key) => (
            <button type="button" className="chip" key={key} onClick={() => void send(t(key))} disabled={!apiKey}>
              {t(key)}
            </button>
          ))}
        </div>
      ) : null}

      {!apiKey ? (
        <div className="notice info chat-nokey">
          <span>{t('chat.noKey')}</span>
          <button type="button" className="btn secondary" onClick={onOpenProfile}>
            {t('nav.profile')}
          </button>
        </div>
      ) : capped ? (
        <div className="notice chat-nokey">
          <span>{t('chat.capped', { cap: MONTHLY_CAP_USD.toFixed(2) })}</span>
          <button type="button" className="btn secondary" onClick={onOpenProfile}>
            {t('nav.profile')}
          </button>
        </div>
      ) : (
        <form
          className="chat-input-row"
          onSubmit={(event) => {
            event.preventDefault()
            void send(input)
          }}
        >
          <input
            type="text"
            autoComplete="off"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
          />
          <button type="submit" className="chat-send" disabled={!input.trim() || sending} aria-label={t('chat.send')}>
            <IconSend />
          </button>
        </form>
      )}

      {confirmingClear ? (
        <ConfirmDialog
          message={t('chat.clearConfirm')}
          confirmLabel={t('chat.clear')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            clearChat()
            setConfirmingClear(false)
          }}
        />
      ) : null}

      {creatingFood ? (
        <div className="chat-overlay">
          <CustomFoodSheet
            initialName={creatingFood.item.name}
            initialValues={{
              kcal: creatingFood.item.kcal,
              protein: creatingFood.item.protein,
              carbs: creatingFood.item.carbs,
              fat: creatingFood.item.fat,
            }}
            onClose={() => setCreatingFood(null)}
            onCreated={(food) => {
              addEntry(todayKey(), defaultMeal(), food, creatingFood.item.grams)
              setCreatedFoods((current) => ({
                ...current,
                [`${creatingFood.messageId}-${creatingFood.mealIndex}-${creatingFood.itemIndex}`]: true,
              }))
              setCreatingFood(null)
              onToast(t('chat.foodAdded'))
            }}
          />
        </div>
      ) : null}

      {schedulingMeal ? (
        <div className="chat-overlay">
          <SchedulePicker
            initialMeal={schedulingMeal.initialMeal}
            onClose={() => setSchedulingMeal(null)}
            onPick={(date, meal) => {
              addMealToDiary(date, schedulingMeal.items, meal)
              setScheduledMeals((current) => ({
                ...current,
                [`${schedulingMeal.messageId}-${schedulingMeal.mealIndex}`]: { date, meal },
              }))
              setSchedulingMeal(null)
              onToast(t('chat.mealScheduled', { date: formatDay(date, lang) }))
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
