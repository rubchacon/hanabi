import Fireworks from "fireworks-canvas";
import { last, omit, shuffle } from "lodash";
import { useRouter } from "next/router";
import React, { useEffect, useRef, useState } from "react";
import shortid from "shortid";

import { ActionAreaType, ISelectedArea } from "~/components/actionArea";
import DiscardArea from "~/components/discardArea";
import GameBoard from "~/components/gameBoard";
import InstructionsArea from "~/components/instructionsArea";
import LoadingScreen from "~/components/loadingScreen";
import Lobby from "~/components/lobby";
import MenuArea from "~/components/menuArea";
import PlayersBoard from "~/components/playersBoard";
import ReplayViewer from "~/components/replayViewer";
import RollbackArea from "~/components/rollbackArea";
import Tutorial, {
  ITutorialStep,
  TutorialProvider
} from "~/components/tutorial";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import {
  commitAction,
  getMaximumPossibleScore,
  getScore,
  isReplayMode,
  joinGame,
  newGame
} from "~/game/actions";
import play from "~/game/ai";
import cheat from "~/game/ai-cheater";
import { playSound } from "~/game/sound";
import IGameState, {
  GameMode,
  IGameHintsLevel,
  IGameStatus
} from "~/game/state";
import useConnectivity from "~/hooks/connectivity";
import { GameContext, useCurrentPlayer, useSelfPlayer } from "~/hooks/game";
import useLocalStorage from "~/hooks/localStorage";
import useNetwork from "~/hooks/network";
import usePrevious from "~/hooks/previous";

export default function Play() {
  const network = useNetwork();
  const router = useRouter();
  const online = useConnectivity();
  const [game, setGame] = useState<IGameState>(null);
  const [displayStats, setDisplayStats] = useState(false);
  const [revealCards, setRevealCards] = useState(false);
  const [reachableScore, setReachableScore] = useState<number>(null);
  const [interturn, setInterturn] = useState(false);
  const [, setGameId] = useLocalStorage("gameId", null);
  const [playerId] = useLocalStorage("playerId", shortid());
  const [selectedArea, selectArea] = useState<ISelectedArea>({
    id: "instructions",
    type: ActionAreaType.INSTRUCTIONS
  });
  const fireworksRef = useRef();

  const currentPlayer = useCurrentPlayer(game);
  const selfPlayer = useSelfPlayer(game);

  const { gameId } = router.query;

  /**
   * Request notification permissions when game starts
   */
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (!game) return;
    if (game.status !== IGameStatus.ONGOING) return;

    if (Notification.permission !== "granted") {
      Notification.requestPermission();
    }
  }, [game && game.status === IGameStatus.ONGOING]);

  /**
   * Load game from database
   */
  useEffect(() => {
    if (!online) return;

    return network.subscribeToGame(gameId as string, game => {
      if (!game) {
        return router.push("/404");
      }

      setGame({ ...game, synced: true });
    });
  }, [gameId, online]);

  /**
   * Resets the selected area when a player plays.
   */
  useEffect(() => {
    selectArea({ id: "instructions", type: ActionAreaType.INSTRUCTIONS });
  }, [game && game.turnsHistory.length]);

  /**
   * Toggle interturn state on new turn for pass & play
   */
  useEffect(() => {
    if (!game) return;
    if (game.options.gameMode !== GameMode.PASS_AND_PLAY) return;
    if (game.players.length < game.options.playersCount) return;
    if (game.status !== IGameStatus.ONGOING) return;

    setInterturn(true);
  }, [
    game && game.turnsHistory.length,
    game && game.players.length,
    game && game.status
  ]);

  /**
   * Notify player it's time to play when document isn't focused.
   */
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (!currentPlayer) return;
    if (currentPlayer !== selfPlayer) return;
    if (document.hasFocus()) return;

    const title = "Your turn!";
    const options = {
      icon: "/static/hanabi-192.png"
    };

    try {
      // Attempt sending the notification through the Web API.
      const notification = new Notification(title, options);

      const onNotificationClick = () => {
        window.focus();
        notification.close();
      };

      let closeTimeout;
      notification.onshow = () => {
        closeTimeout = setTimeout(() => {
          notification.close.bind(notification);
        }, 20000);
      };

      notification.addEventListener("click", onNotificationClick);

      return () => {
        notification.removeEventListener("click", onNotificationClick);

        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
      };
    } catch (e) {
      // Not handled for many mobile browsers.
    }
  }, [currentPlayer === selfPlayer]);

  /**
   * Handle notification sounds.
   */
  useEffect(() => {
    if (!selfPlayer) return;
    if (!selfPlayer.notified) return;

    playSound(`/static/sounds.bell.mp3`);
    const timeout = setTimeout(
      () => network.setNotification(game, selfPlayer, false),
      10000
    );

    return () => clearTimeout(timeout);
  }, [selfPlayer && selfPlayer.notified]);

  /**
   * Play sound when gaining a hint token
   */
  const hintsCount = game ? game.tokens.hints : 0;
  const previousHintsCount = usePrevious(hintsCount);
  useEffect(() => {
    if (previousHintsCount === undefined) return;

    const timeout = setTimeout(() => {
      playSound(`/static/sounds/coin.mp3`);
    }, 500);

    return () => clearTimeout(timeout);
  }, [hintsCount === previousHintsCount + 1]);

  useEffect(() => {
    if (previousHintsCount === undefined) return;

    const timeout = setTimeout(() => {
      playSound(`/static/sounds/swoosh.wav`);
    }, 200);

    return () => clearTimeout(timeout);
  }, [hintsCount === previousHintsCount - 1]);

  const turnsCount = game ? game.turnsHistory.length : 0;
  const previousTurnsCount = usePrevious(turnsCount);
  useEffect(() => {
    if (previousTurnsCount === undefined) return;

    playSound(`/static/sounds/rewind.mp3`);
  }, [turnsCount < previousTurnsCount]);

  /**
   * Play sound when discarding a card
   */
  useEffect(() => {
    if (!game) return;
    if (!game.discardPile.length) return;

    playSound(`/static/sounds/card-scrape.mp3`);
  }, [game && game.discardPile.length]);

  /**
   * Play sound when successfully playing a card
   */
  useEffect(() => {
    if (!game) return;

    const latestCard = last(game.playedCards);
    if (!latestCard) return;

    const path =
      latestCard.number === 5
        ? `/static/sounds/play-5.mp3`
        : `/static/sounds/play.mp3`;

    playSound(path);
  }, [game && game.playedCards.length]);

  /**
   * Play for bots.
   */
  useEffect(() => {
    if (!game) return;
    if (!game.synced) return;
    if (game.status !== IGameStatus.ONGOING) return;
    if (!selfPlayer || selfPlayer.index) return;
    if (!currentPlayer.bot) return;

    if (game.options.botsWait === 0) {
      network.updateGame(play(game));
      return;
    }

    network.setReaction(game, currentPlayer, "🧠");
    const timeout = setTimeout(() => {
      network.updateGame(play(game));
      game.options.botsWait && network.setReaction(game, currentPlayer, null);
    }, game.options.botsWait);

    return () => clearTimeout(timeout);
  }, [game && game.currentPlayer, game && game.status, game && game.synced]);

  /**
   * At the start of the game, compute and store the maximum score
   * that our cheating AI can achieve.
   */
  useEffect(() => {
    if (!game) return;
    if (![IGameStatus.ONGOING, IGameStatus.OVER].includes(game.status)) return;

    let sameGame = newGame({
      id: game.id,
      playersCount: game.options.playersCount,
      variant: game.options.variant,
      allowRollback: false,
      preventLoss: false,
      seed: game.options.seed,
      private: true,
      hintsLevel: IGameHintsLevel.NONE,
      botsWait: 1000,
      turnsHistory: false,
      gameMode: GameMode.NETWORK
    });

    game.players.forEach(player => {
      sameGame = joinGame(sameGame, {
        id: player.id,
        name: player.name,
        bot: true
      });
    });

    while (sameGame.status !== IGameStatus.OVER) {
      sameGame = cheat(sameGame);
    }

    setReachableScore(getScore(sameGame));
  }, [game && game.status]);

  /**
   * Display fireworks animation when game ends
   */
  useEffect(() => {
    if (!game) return;
    if (game.status !== IGameStatus.OVER) return;

    const fireworks = new Fireworks(fireworksRef.current, {
      maxRockets: 5, // max # of rockets to spawn
      rocketSpawnInterval: 150, // milliseconds to check if new rockets should spawn
      numParticles: 100, // number of particles to spawn when rocket explodes (+0-10)
      explosionMinHeight: 10, // minimum percentage of height of container at which rockets explode
      explosionChance: 1 // chance in each tick the rocket will explode
    });
    fireworks.start();

    const timeout = setTimeout(() => {
      fireworks.stop();
    }, game.playedCards.length * 200); // stop rockets from spawning

    return () => clearTimeout(timeout);
  }, [game && game.status]);

  /**
   * Redirect players to next game
   */
  const previousNextGameId = usePrevious(game ? game.nextGameId : null);
  useEffect(() => {
    if (!game) return;
    if (!game.nextGameId) return;
    if (!previousNextGameId) return;

    router.push(`/play?gameId=${game.nextGameId}`);
  }, [game && game.nextGameId]);

  function onJoinGame(player) {
    const newState = joinGame(game, { id: playerId, ...player });

    setGame({ ...newState, synced: false });
    network.updateGame(newState);

    setGameId(game.id);
  }

  function onAddBot() {
    const playerId = shortid();
    const botsCount = game.players.filter(p => p.bot).length;

    const bot = {
      name: `AI #${botsCount + 1}`
    };
    const newState = joinGame(game, { id: playerId, ...bot, bot: true });

    setGame({ ...newState, synced: false });
    network.updateGame(newState);
  }

  async function onStartGame() {
    const newState = {
      ...game,
      status: IGameStatus.ONGOING
    };

    setGame({ ...newState, synced: false });
    network.updateGame(newState);
  }

  async function onCommitAction(action) {
    const newState = commitAction(game, action);
    const misplay =
      getMaximumPossibleScore(game) !== getMaximumPossibleScore(newState);
    if (game.options.preventLoss && misplay) {
      if (!window.confirm("You fucked up · Keep going?")) {
        return;
      }
    }

    if (game.options.gameMode === GameMode.PASS_AND_PLAY) {
      setInterturn(true);
    }

    setGame({ ...newState, synced: false });
    network.updateGame(newState);
  }

  function onCloseArea() {
    selectArea({
      id: "instructions",
      type: ActionAreaType.INSTRUCTIONS
    });
  }

  function onRollbackClick() {
    onSelectArea({
      id: "rollback",
      type: ActionAreaType.ROLLBACK
    });
  }

  async function onNotifyPlayer(player) {
    network.setNotification(game, player, true);
  }

  async function onReaction(reaction) {
    network.setReaction(game, selfPlayer, reaction);
  }

  /*
   * Area management functions
   */

  function onSelectArea(area: ISelectedArea) {
    if (area.id === selectedArea.id) {
      return selectArea({
        id: "instructions",
        type: ActionAreaType.INSTRUCTIONS
      });
    }

    selectArea(area);
  }

  function onSelectPlayer(player, cardIndex) {
    const self = player.id === selfPlayer?.id;

    if (displayStats) {
      return;
    }

    onSelectArea({
      id: self ? `game-${player.id}-${cardIndex}` : `game-${player.id}`,
      type: self ? ActionAreaType.SELF_PLAYER : ActionAreaType.OTHER_PLAYER,
      player,
      cardIndex
    });
  }

  function onMenuClick() {
    onSelectArea({
      id: "menu",
      type: ActionAreaType.MENU
    });
  }

  function onReplay() {
    setDisplayStats(false);
    setRevealCards(true);
    network.updateGame({
      ...game,
      replayCursor: game.turnsHistory.length
    });
  }

  function onReplayCursorChange(replayCursor: number) {
    network.updateGame({
      ...game,
      replayCursor
    });
  }

  function onStopReplay() {
    network.updateGame({
      ...omit(game, ["replayCursor"]),
      synced: false
    });
  }

  function onToggleStats() {
    setDisplayStats(!displayStats);

    selectArea({
      id: "instructions",
      type: ActionAreaType.INSTRUCTIONS
    });
  }

  async function onRestartGame() {
    const nextGameId = shortid();

    let nextGame = newGame({
      ...game.options,
      id: nextGameId,
      seed: `${Math.round(Math.random() * 10000)}`
    });

    shuffle(game.players).forEach(player => {
      nextGame = joinGame(nextGame, player);
    });

    await network.updateGame(nextGame);

    network.updateGame({ ...game, nextGameId });
  }

  if (!game) {
    return <LoadingScreen />;
  }

  return (
    <TutorialProvider>
      <GameContext.Provider value={game}>
        <div className="bg-main-dark relative flex flex-column w-100 h-100">
          <GameBoard
            onMenuClick={onMenuClick}
            onRollbackClick={onRollbackClick}
          />
          <div className="flex flex-column bg-black-50 bb b--yellow ph6.5-m">
            {game.status === IGameStatus.LOBBY && (
              <Lobby
                onAddBot={onAddBot}
                onJoinGame={onJoinGame}
                onStartGame={onStartGame}
              />
            )}

            {selectedArea.type === ActionAreaType.MENU && (
              <div className="h3 pa2 ph3-l">
                <MenuArea onCloseArea={onCloseArea} />
              </div>
            )}

            {selectedArea.type === ActionAreaType.ROLLBACK && (
              <div className="h3 pa2 ph3-l">
                <RollbackArea onCloseArea={onCloseArea} />
              </div>
            )}

            <div className="h4 pt0-l overflow-y-scroll">
              <div className="flex justify-between h-100 pa1 pa2-l">
                <InstructionsArea
                  interturn={interturn}
                  reachableScore={reachableScore}
                  onReplay={onReplay}
                  onToggleStats={onToggleStats}
                />
                <Tutorial placement="above" step={ITutorialStep.DISCARD_PILE}>
                  <DiscardArea />
                </Tutorial>
              </div>
            </div>
          </div>

          {interturn && (
            <div className="flex-grow-1 flex flex-column items-center justify-center">
              <Txt
                size={TxtSize.MEDIUM}
                value={`It's ${currentPlayer.name}'s turn!`}
              />
              <Button
                primary
                className="mt4"
                size={ButtonSize.MEDIUM}
                text={`Go !`}
                onClick={() => setInterturn(false)}
              />
            </div>
          )}
          {!interturn && (
            <div className="flex flex-grow-1 flex-column">
              <div className="h-100">
                <PlayersBoard
                  displayStats={displayStats}
                  revealCards={revealCards}
                  selectedArea={selectedArea}
                  onCloseArea={onCloseArea}
                  onCommitAction={onCommitAction}
                  onNotifyPlayer={onNotifyPlayer}
                  onReaction={onReaction}
                  onSelectPlayer={onSelectPlayer}
                />
              </div>
            </div>
          )}
          {game.status === IGameStatus.OVER && (
            <div className="flex flex-column bg-black-50 bt b--yellow pv3 pv4-l ph6.5-m">
              {isReplayMode(game) && (
                <ReplayViewer
                  onReplayCursorChange={onReplayCursorChange}
                  onStopReplay={onStopReplay}
                />
              )}

              {!isReplayMode(game) && (
                <div className="flex flex-column flex-row-l justify-between items-center w-100 pb2 ph2 ph0-l">
                  <div className="w-100 w-60-l">
                    <Txt
                      className="db"
                      size={TxtSize.MEDIUM}
                      value={`The game is over! • Your score is ${game.playedCards.length} 🎉`}
                    />
                    {reachableScore && (
                      <Txt
                        multiline
                        className="db mt1 lavender"
                        size={TxtSize.SMALL}
                        value={`Estimated max score for this shuffle: ${reachableScore}. ${
                          reachableScore > game.playedCards.length
                            ? "Keep practicing"
                            : "You did great!"
                        }`}
                      />
                    )}
                  </div>
                  <div className="flex w-100 w-40-l flex-wrap items-start mt2 mt0-l">
                    <div className="flex w-100-l">
                      <Button
                        primary
                        className="nowrap ma1 flex-1"
                        size={ButtonSize.TINY}
                        text="New game"
                        onClick={() => onRestartGame()}
                      />
                      <Button
                        className="nowrap ma1 flex-1"
                        size={ButtonSize.TINY}
                        text="Watch replay"
                        onClick={() => onReplay()}
                      />
                    </div>
                    <div className="flex w-100-l">
                      <Button
                        className="nowrap ma1 flex-1"
                        size={ButtonSize.TINY}
                        text={displayStats ? "Hide stats" : "Show stats"}
                        onClick={() => onToggleStats()}
                      />
                      <Button
                        className="nowrap ma1 flex-1"
                        size={ButtonSize.TINY}
                        text={revealCards ? "Hide cards" : "Reveal cards"}
                        onClick={() => {
                          setRevealCards(!revealCards);
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          ref={fireworksRef}
          className="fixed absolute--fill z-999"
          style={{ pointerEvents: "none" }}
        />
      </GameContext.Provider>
    </TutorialProvider>
  );
}
